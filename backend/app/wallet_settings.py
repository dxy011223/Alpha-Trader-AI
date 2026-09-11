from datetime import UTC, datetime

from app.database import SessionLocal
from app.models import WalletSettings
from app.schemas import WalletSettingsResponse, WalletSettingsUpdate


def _response(settings: WalletSettings) -> WalletSettingsResponse:
    updated_at = settings.updated_at or datetime.now(UTC)
    return WalletSettingsResponse(address=settings.address, updated_at=updated_at.isoformat())


def read_wallet_settings() -> WalletSettingsResponse | None:
    with SessionLocal() as session:
        settings = session.get(WalletSettings, 1)
        return _response(settings) if settings else None


def write_wallet_settings(payload: WalletSettingsUpdate) -> WalletSettingsResponse:
    with SessionLocal.begin() as session:
        settings = session.get(WalletSettings, 1)
        if settings is None:
            settings = WalletSettings(id=1, address=payload.address.lower())
            session.add(settings)
        else:
            settings.address = payload.address.lower()
        session.flush()
        return _response(settings)
