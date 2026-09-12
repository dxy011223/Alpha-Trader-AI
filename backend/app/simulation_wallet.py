from datetime import UTC, datetime
from decimal import Decimal

from app.database import SessionLocal
from app.models import SimulationWalletState
from app.schemas import SimulationWalletResponse, SimulationWalletUpdate
from app.services import MarketPlatform


DEFAULT_SIMULATION_BALANCE = Decimal("1000.00000000")


def _storage_key(client_id: str, platform: MarketPlatform) -> str:
    return f"{client_id}__{platform}"


def _response(
    record: SimulationWalletState | None,
    client_id: str,
    platform: MarketPlatform,
) -> SimulationWalletResponse:
    stored_trades = record.active_trade if record is not None else None
    active_trades = (
        stored_trades if isinstance(stored_trades, list)
        else [stored_trades] if isinstance(stored_trades, dict)
        else []
    )[:3]
    return SimulationWalletResponse(
        client_id=client_id,
        platform=platform,
        enabled=record.enabled if record is not None else False,
        balance=float(record.balance) if record is not None else float(DEFAULT_SIMULATION_BALANCE),
        activeTrades=active_trades,
        activeTrade=active_trades[0] if active_trades else None,
        history=(record.history or []) if record is not None else [],
        updated_at=(record.updated_at if record is not None else None) or datetime.now(UTC),
    )


def read_simulation_wallet(
    client_id: str, platform: MarketPlatform
) -> SimulationWalletResponse:
    storage_key = _storage_key(client_id, platform)
    with SessionLocal() as session:
        record = session.get(SimulationWalletState, storage_key)
        return _response(record, client_id, platform)


def write_simulation_wallet(
    client_id: str,
    platform: MarketPlatform,
    payload: SimulationWalletUpdate,
) -> SimulationWalletResponse:
    storage_key = _storage_key(client_id, platform)
    with SessionLocal.begin() as session:
        record = session.get(SimulationWalletState, storage_key)
        if record is None:
            record = SimulationWalletState(client_id=storage_key)
            session.add(record)
        record.enabled = payload.enabled
        record.balance = Decimal(str(payload.balance))
        active_trades = payload.activeTrades
        if active_trades is None:
            active_trades = [payload.activeTrade] if payload.activeTrade else []
        record.active_trade = [trade.model_dump(mode="json") for trade in active_trades] or None
        record.history = [trade.model_dump(mode="json") for trade in payload.history]
        record.updated_at = datetime.now(UTC)
        session.flush()
        return _response(record, client_id, platform)
