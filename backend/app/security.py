import asyncio
import base64
import hashlib
import secrets
import time
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.config import get_settings


_bearer = HTTPBearer(auto_error=False)
_quota_lock = asyncio.Lock()
_minute_counts: dict[tuple[str, int], int] = defaultdict(int)
_day_counts: dict[tuple[str, int], int] = defaultdict(int)
_concurrency: asyncio.Semaphore | None = None
_concurrency_size = 0

_WORKER_SIGNING_PUBLIC_KEY = b"""-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEIxHD9f9bENpeXkebAeNBiILIR/b5
oRYJpm3uB8ZoSrmV2wfCrpS8rnbsyYnB66qamup5sHLBlPtAzwHwLYV2DQ==
-----END PUBLIC KEY-----
"""
_WORKER_SIGNATURE_MAX_AGE_SECONDS = 60

_QUOTA_SCRIPT = """
local minute_count = tonumber(redis.call('GET', KEYS[1]) or '0')
local day_count = tonumber(redis.call('GET', KEYS[2]) or '0')
if minute_count >= tonumber(ARGV[1]) or day_count >= tonumber(ARGV[2]) then
  return 0
end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], 120)
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 172800)
return 1
"""


class AIBudgetUnavailable(RuntimeError):
    """模型预算不可用或已经耗尽，调用方必须保留规则分析结果。"""


async def _has_valid_worker_signature(request: Request) -> bool:
    """校验 Cloudflare Worker 的短时签名，避免托管平台间同步共享密钥。"""
    timestamp_value = request.headers.get("x-alpha-worker-timestamp", "")
    signature_value = request.headers.get("x-alpha-worker-signature", "")
    try:
        timestamp = int(timestamp_value)
        if abs(int(time.time()) - timestamp) > _WORKER_SIGNATURE_MAX_AGE_SECONDS:
            return False
        padding = "=" * (-len(signature_value) % 4)
        signature = base64.urlsafe_b64decode(signature_value + padding)
        if len(signature) == 64:
            signature = encode_dss_signature(
                int.from_bytes(signature[:32], "big"),
                int.from_bytes(signature[32:], "big"),
            )
        body_hash = hashlib.sha256(await request.body()).hexdigest()
        path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
        message = f"{timestamp_value}\n{request.method.upper()}\n{path}\n{body_hash}".encode()
        public_key = serialization.load_pem_public_key(_WORKER_SIGNING_PUBLIC_KEY)
        public_key.verify(signature, message, ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, TypeError, ValueError):
        return False


async def require_owner(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str:
    """校验 Worker 签名或个人部署的所有者令牌，不暴露敏感信息。"""
    if await _has_valid_worker_signature(request):
        return hashlib.sha256(b"cloudflare-worker-owner").hexdigest()[:24]
    settings = get_settings()
    expected = (settings.owner_api_token or "").strip()
    client_host = request.client.host if request.client else ""
    if not expected:
        # 仅方便本机开发；生产环境或非回环请求仍必须配置访问令牌。
        if settings.environment.lower() != "production" and client_host in {"127.0.0.1", "::1", "testclient"}:
            return hashlib.sha256(b"local-development-owner").hexdigest()[:24]
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="服务端尚未配置访问令牌",
        )
    supplied = credentials.credentials if credentials and credentials.scheme.lower() == "bearer" else ""
    if not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="访问令牌无效或缺失",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return hashlib.sha256(supplied.encode("utf-8")).hexdigest()[:24]


def require_secure_transport(request: Request) -> None:
    """凭证始终只允许从 HTTPS 或本机回环地址提交。"""
    client_host = request.client.host if request.client else ""
    is_loopback = client_host in {"127.0.0.1", "::1", "testclient"}
    # 不直接信任客户端可伪造的 X-Forwarded-Proto；反向代理必须在受信边界内
    # 将真实协议写入 ASGI scope。
    if request.url.scheme != "https" and not is_loopback:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="交易所凭证只能通过 HTTPS 或本机连接提交",
        )


async def _consume_redis_quota(owner: str, minute_limit: int, day_limit: int) -> bool | None:
    settings = get_settings()
    client: Redis | None = None
    try:
        client = Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        now = int(time.time())
        minute_key = f"alpha-trader:quota:{owner}:minute:{now // 60}"
        day_key = f"alpha-trader:quota:{owner}:day:{now // 86400}"
        result = await client.eval(
            _QUOTA_SCRIPT,
            2,
            minute_key,
            day_key,
            max(1, minute_limit),
            max(1, day_limit),
        )
        return bool(result)
    except (RedisError, ValueError):
        return None
    finally:
        if client is not None:
            await client.aclose()


async def _consume_memory_quota(owner: str, minute_limit: int, day_limit: int) -> bool:
    now = int(time.time())
    minute_bucket = now // 60
    day_bucket = now // 86400
    async with _quota_lock:
        minute_key = (owner, minute_bucket)
        day_key = (owner, day_bucket)
        if _minute_counts[minute_key] >= minute_limit or _day_counts[day_key] >= day_limit:
            return False
        _minute_counts[minute_key] += 1
        _day_counts[day_key] += 1
        # 只保留当前时间桶，避免本机降级计数器自身无界增长。
        for key in list(_minute_counts):
            if key[1] < minute_bucket:
                del _minute_counts[key]
        for key in list(_day_counts):
            if key[1] < day_bucket:
                del _day_counts[key]
    return True


def _semaphore(limit: int) -> asyncio.Semaphore:
    global _concurrency, _concurrency_size
    normalized = max(1, limit)
    if _concurrency is None or _concurrency_size != normalized:
        _concurrency = asyncio.Semaphore(normalized)
        _concurrency_size = normalized
    return _concurrency


@asynccontextmanager
async def ai_call_slot():
    """在实际模型调用边界应用所有者级频率、日预算和本进程并发上限。"""
    settings = get_settings()
    raw_owner = (settings.owner_api_token or "scheduled-owner").encode("utf-8")
    owner = hashlib.sha256(raw_owner).hexdigest()[:24]
    minute_limit = max(1, settings.ai_requests_per_minute)
    day_limit = max(1, settings.ai_requests_per_day)
    allowed = await _consume_redis_quota(owner, minute_limit, day_limit)
    if allowed is None:
        if settings.environment.lower() == "production":
            raise AIBudgetUnavailable("生产环境的 Redis 配额服务不可用")
        allowed = await _consume_memory_quota(owner, minute_limit, day_limit)
    if not allowed:
        raise AIBudgetUnavailable("模型分析额度已用尽")

    semaphore = _semaphore(settings.ai_max_concurrency)
    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=1.0)
    except TimeoutError as exc:
        raise AIBudgetUnavailable("模型分析并发已达上限") from exc
    try:
        yield
    finally:
        semaphore.release()
