from datetime import UTC, datetime
from decimal import Decimal

from app.database import SessionLocal
from app.models import CapitalSettings
from app.schemas import CapitalSettingsResponse, CapitalSettingsUpdate


DEFAULT_TOTAL_AMOUNT = Decimal("10000.00")


def _to_response(settings: CapitalSettings) -> CapitalSettingsResponse:
    updated_at = settings.updated_at or datetime.now(UTC)
    return CapitalSettingsResponse(
        total_amount=float(settings.total_amount),
        currency=settings.currency,
        updated_at=updated_at.isoformat(),
    )


def read_capital_settings() -> CapitalSettingsResponse:
    with SessionLocal() as session:
        settings = session.get(CapitalSettings, 1)
        if settings is None:
            settings = CapitalSettings(id=1, total_amount=DEFAULT_TOTAL_AMOUNT, currency="USDT")
            session.add(settings)
            session.commit()
            session.refresh(settings)
        return _to_response(settings)


def write_capital_settings(payload: CapitalSettingsUpdate) -> CapitalSettingsResponse:
    with SessionLocal() as session:
        settings = session.get(CapitalSettings, 1)
        if settings is None:
            settings = CapitalSettings(id=1, total_amount=Decimal(str(payload.total_amount)), currency=payload.currency)
            session.add(settings)
        else:
            settings.total_amount = Decimal(str(payload.total_amount))
            settings.currency = payload.currency
        session.commit()
        session.refresh(settings)
        return _to_response(settings)
