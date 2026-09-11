from cryptography.fernet import Fernet
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.database import Base
from app.models import PlatformCredential
from app.platform_credentials import (
    read_platform_credential_status,
    read_platform_credentials,
    write_platform_credentials,
)
from app.schemas import PlatformCredentialUpdate


def _prepare_database(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    test_session = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr("app.platform_credentials.SessionLocal", test_session)
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(
        "app.platform_credentials.get_settings",
        lambda: Settings(credential_encryption_key=key),
    )
    return test_session


def test_platform_credentials_are_encrypted_and_masked(monkeypatch):
    test_session = _prepare_database(monkeypatch)
    response = write_platform_credentials(
        "binance",
        PlatformCredentialUpdate(api_key="abcd1234key", secret_key="super-secret-key"),
    )

    assert response.configured is True
    assert response.api_key_hint == "abcd…4key"
    with test_session() as session:
        record = session.scalar(select(PlatformCredential))
        assert record is not None
        assert "abcd1234key" not in record.encrypted_api_key
        assert "super-secret-key" not in record.encrypted_secret_key

    values = read_platform_credentials("binance")
    assert values is not None
    assert values.api_key == "abcd1234key"
    assert values.secret_key == "super-secret-key"
    assert read_platform_credential_status("binance").api_key_hint == "abcd…4key"


def test_okx_requires_passphrase(monkeypatch):
    _prepare_database(monkeypatch)
    try:
        write_platform_credentials(
            "okx",
            PlatformCredentialUpdate(api_key="okx-key", secret_key="okx-secret"),
        )
    except ValueError as exc:
        assert "Passphrase" in str(exc)
    else:
        raise AssertionError("缺少 Passphrase 时应拒绝保存 OKX 凭证")


def test_missing_encryption_key_is_rejected(monkeypatch):
    _prepare_database(monkeypatch)
    monkeypatch.setattr(
        "app.platform_credentials.get_settings",
        lambda: Settings(credential_encryption_key=None),
    )
    try:
        write_platform_credentials(
            "binance",
            PlatformCredentialUpdate(api_key="abcd1234", secret_key="super-secret"),
        )
    except RuntimeError as exc:
        assert "加密密钥" in str(exc)
    else:
        raise AssertionError("未配置主密钥时不应保存凭证")
