import logging
import secrets

from redis import Redis
from redis.exceptions import RedisError

from app.config import get_settings
from app.schemas import OpportunityScanResponse

logger = logging.getLogger(__name__)

_RELEASE_LOCK_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


def _key(
    timeframe: str,
    platform: str = "hyperliquid",
    total_amount: float | None = None,
) -> str:
    capital_key = "default" if total_amount is None else format(total_amount, ".12g")
    return f"alpha-trader:opportunities:{platform}:{timeframe}:{capital_key}"


def _plan_key(timeframe: str, platform: str = "hyperliquid") -> str:
    return f"alpha-trader:decision-plans:{platform}:{timeframe}"


def clear_market_scan_cache() -> None:
    """资金设置变化后清除短期扫描结果，保留固定决策计划。"""
    settings = get_settings()
    client = None
    try:
        client = Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        keys = [key for key in client.scan_iter(match="alpha-trader:opportunities:*") if not key.endswith(":lock")]
        if keys:
            client.delete(*keys)
    except (RedisError, ValueError) as exc:
        logger.warning("Redis 市场扫描缓存清理失败：%s", exc)
    finally:
        if client is not None:
            client.close()


def acquire_scan_lock(timeframe: str, platform: str, total_amount: float | None = None) -> str | None:
    """返回租约令牌；空字符串表示其他进程持有，None 表示 Redis 不可用。"""
    settings = get_settings()
    client = None
    token = secrets.token_urlsafe(24)
    try:
        client = Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        acquired = client.set(
            f"{_key(timeframe, platform, total_amount)}:lock", token, nx=True, ex=90
        )
        return token if acquired else ""
    except (RedisError, ValueError) as exc:
        logger.warning("Redis 市场扫描租约获取失败：%s", exc)
        return None
    finally:
        if client is not None:
            client.close()


def release_scan_lock(
    timeframe: str, platform: str, token: str, total_amount: float | None = None
) -> None:
    if not token:
        return
    settings = get_settings()
    client = None
    try:
        client = Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        client.eval(
            _RELEASE_LOCK_SCRIPT,
            1,
            f"{_key(timeframe, platform, total_amount)}:lock",
            token,
        )
    except (RedisError, ValueError) as exc:
        logger.warning("Redis 市场扫描租约释放失败：%s", exc)
    finally:
        if client is not None:
            client.close()


def write_timeframe_scan_cache(timeframe: str, scan: OpportunityScanResponse) -> None:
    settings = get_settings()
    client = None
    try:
        client = Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        client.setex(
            _key(timeframe, scan.platform, scan.total_amount),
            settings.market_scan_cache_seconds,
            scan.model_dump_json(),
        )
    except (RedisError, ValueError) as exc:
        logger.warning("Redis 市场扫描缓存写入失败：%s", exc)
    finally:
        if client is not None:
            client.close()


def write_decision_plan_cache(timeframe: str, scan: OpportunityScanResponse) -> None:
    """保存跨扫描周期的固定计划；具体过期仍由每条计划的生成时间判定。"""
    settings = get_settings()
    client = None
    try:
        client = Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        client.setex(_plan_key(timeframe, scan.platform), 172_800, scan.model_dump_json())
    except (RedisError, ValueError) as exc:
        logger.warning("Redis 决策计划缓存写入失败：%s", exc)
    finally:
        if client is not None:
            client.close()


def read_scan_cache(
    timeframe: str,
    limit: int,
    platform: str = "hyperliquid",
    total_amount: float | None = None,
) -> OpportunityScanResponse | None:
    settings = get_settings()
    client = None
    try:
        client = Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        value = client.get(_key(timeframe, platform, total_amount))
        if not value:
            return None
        scan = OpportunityScanResponse.model_validate_json(value)
        return scan.model_copy(update={
            "opportunities": scan.opportunities[:limit],
            "scan_source": "scheduled_cache",
        })
    except (RedisError, ValueError, TypeError) as exc:
        logger.warning("Redis 市场扫描缓存读取失败：%s", exc)
        return None
    finally:
        if client is not None:
            client.close()


def read_decision_plan_cache(
    timeframe: str, platform: str = "hyperliquid"
) -> OpportunityScanResponse | None:
    settings = get_settings()
    client = None
    try:
        client = Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        value = client.get(_plan_key(timeframe, platform))
        return OpportunityScanResponse.model_validate_json(value) if value else None
    except (RedisError, ValueError, TypeError) as exc:
        logger.warning("Redis 决策计划缓存读取失败：%s", exc)
        return None
    finally:
        if client is not None:
            client.close()
