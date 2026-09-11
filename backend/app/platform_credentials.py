from dataclasses import dataclass
from typing import Literal

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select

from app.config import get_settings
from app.database import SessionLocal
from app.models import PlatformCredential
from app.schemas import PlatformCredentialResponse, PlatformCredentialUpdate

PrivatePlatform = Literal["binance", "okx"]


@dataclass(frozen=True)
class PlatformCredentialValues:
    api_key: str
    secret_key: str
    passphrase: str | None


def _fernet() -> Fernet:
    key = get_settings().credential_encryption_key
    if not key:
        raise RuntimeError("后端尚未配置交易所凭证加密密钥")
    try:
        return Fernet(key.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        raise RuntimeError("交易所凭证加密密钥格式无效") from exc


def _encrypt(value: str, fernet: Fernet) -> str:
    return fernet.encrypt(value.encode("utf-8")).decode("ascii")


def _decrypt(value: str, fernet: Fernet) -> str:
    try:
        return fernet.decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeError, ValueError) as exc:
        raise RuntimeError("交易所凭证解密失败，请重新保存凭证") from exc


def _key_hint(api_key: str) -> str:
    if len(api_key) <= 8:
        return f"{api_key[:2]}…{api_key[-2:]}"
    return f"{api_key[:4]}…{api_key[-4:]}"


def read_platform_credential_status(platform: PrivatePlatform) -> PlatformCredentialResponse:
    with SessionLocal() as session:
        record = session.scalar(
            select(PlatformCredential).where(PlatformCredential.platform == platform).limit(1)
        )
        if record is None:
            return PlatformCredentialResponse(platform=platform, configured=False)
        api_key = _decrypt(record.encrypted_api_key, _fernet())
        return PlatformCredentialResponse(
            platform=platform,
            configured=True,
            api_key_hint=_key_hint(api_key),
            updated_at=record.updated_at,
        )


def read_platform_credentials(platform: PrivatePlatform) -> PlatformCredentialValues | None:
    with SessionLocal() as session:
        record = session.scalar(
            select(PlatformCredential).where(PlatformCredential.platform == platform).limit(1)
        )
        if record is None:
            return None
        fernet = _fernet()
        return PlatformCredentialValues(
            api_key=_decrypt(record.encrypted_api_key, fernet),
            secret_key=_decrypt(record.encrypted_secret_key, fernet),
            passphrase=(
                _decrypt(record.encrypted_passphrase, fernet)
                if record.encrypted_passphrase
                else None
            ),
        )


def write_platform_credentials(
    platform: PrivatePlatform,
    payload: PlatformCredentialUpdate,
) -> PlatformCredentialResponse:
    if platform == "okx" and payload.passphrase is None:
        raise ValueError("OKX 只读 API 凭证必须填写 Passphrase")
    fernet = _fernet()
    api_key = payload.api_key.get_secret_value().strip()
    secret_key = payload.secret_key.get_secret_value().strip()
    passphrase = payload.passphrase.get_secret_value().strip() if payload.passphrase else None
    if not api_key or not secret_key or (platform == "okx" and not passphrase):
        raise ValueError("交易所只读 API 凭证不能为空")

    with SessionLocal.begin() as session:
        record = session.scalar(
            select(PlatformCredential).where(PlatformCredential.platform == platform).limit(1)
        )
        if record is None:
            record = PlatformCredential(platform=platform)
            session.add(record)
        record.encrypted_api_key = _encrypt(api_key, fernet)
        record.encrypted_secret_key = _encrypt(secret_key, fernet)
        record.encrypted_passphrase = _encrypt(passphrase, fernet) if passphrase else None
        session.flush()
        return PlatformCredentialResponse(
            platform=platform,
            configured=True,
            api_key_hint=_key_hint(api_key),
            updated_at=record.updated_at,
        )
