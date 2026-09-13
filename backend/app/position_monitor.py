import asyncio
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select

from app.database import SessionLocal
from app.models import PositionMonitorRecord
from app.schemas import ExecutionStateResponse, MarketSnapshot, PositionMonitorResponse
from app.services import get_live_market
from app.trade_records import read_active_executions


def _evaluate(state: ExecutionStateResponse, market: MarketSnapshot) -> tuple[str, float, str]:
    position = state.position
    direction_multiplier = 1 if position.direction == "LONG" else -1
    unrealized = (market.price - position.planned_entry) * position.planned_size * direction_multiplier
    first_target = position.take_profit[0]
    final_target = position.take_profit[-1]
    if position.direction == "LONG":
        if market.price <= position.stop_loss or market.price >= final_target:
            return "EXIT", unrealized, "价格已触及结构止损或最终止盈边界"
        if market.price >= first_target:
            return "REDUCE", unrealized, "价格已触及第一止盈目标，建议分批减仓"
        if market.price >= position.planned_entry * 1.02:
            return "ADJUST_SL", unrealized, "浮盈达到约 2%，建议把止损上移至成本附近"
    else:
        if market.price >= position.stop_loss or market.price <= final_target:
            return "EXIT", unrealized, "价格已触及结构止损或最终止盈边界"
        if market.price <= first_target:
            return "REDUCE", unrealized, "价格已触及第一止盈目标，建议分批减仓"
        if market.price <= position.planned_entry * 0.98:
            return "ADJUST_SL", unrealized, "浮盈达到约 2%，建议把止损下移至成本附近"
    return "HOLD", unrealized, "价格仍在计划风险边界内，继续观察"


def _save_monitor(
    state: ExecutionStateResponse,
    market: MarketSnapshot,
    action: str,
    unrealized: float,
    reason: str,
    current_score: int,
) -> PositionMonitorResponse:
    now = datetime.now(UTC)
    with SessionLocal.begin() as session:
        record = session.scalar(
            select(PositionMonitorRecord).where(
                PositionMonitorRecord.position_id == state.position.id
            )
        )
        if record is None:
            record = PositionMonitorRecord(position_id=state.position.id)
            session.add(record)
        record.action = action
        record.current_price = Decimal(str(market.price))
        record.unrealized_pnl = Decimal(str(unrealized))
        record.reason = reason
        record.updated_at = now
        session.flush()
        return PositionMonitorResponse(
            position_id=state.position.id,
            decision_id=state.decision.id,
            symbol=state.position.symbol,
            platform=state.decision.analysis.platform,
            action=action,
            opening_score=state.decision.analysis.score,
            current_score=current_score,
            current_price=market.price,
            unrealized_pnl=round(unrealized, 8),
            reason=reason,
            updated_at=now,
        )


async def monitor_active_positions(platform: str | None = None) -> list[PositionMonitorResponse]:
    states = await asyncio.to_thread(read_active_executions, platform)
    markets = await asyncio.gather(*(
        get_live_market(state.position.symbol, state.decision.analysis.platform)
        for state in states
    ))
    results = []
    for state, market in zip(states, markets, strict=True):
        if market is None:
            continue
        action, unrealized, reason = _evaluate(state, market)
        results.append(await asyncio.to_thread(
            _save_monitor,
            state,
            market,
            action,
            unrealized,
            reason,
            state.decision.analysis.score,
        ))
    return results
