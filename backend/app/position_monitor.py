import asyncio
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select

from app.ai_analysis import AIDecisionUnavailable, generate_position_decisions_with_openai
from app.database import SessionLocal
from app.models import PositionMonitorRecord
from app.schemas import ExecutionStateResponse, MarketSnapshot, PositionMonitorResponse
from app.services import calculate_technical_indicators, get_candles, get_live_market, get_news
from app.trade_records import read_active_executions


def _calculate_unrealized(
    state: ExecutionStateResponse,
    market: MarketSnapshot,
) -> float:
    position = state.position
    direction_multiplier = 1 if position.direction == "LONG" else -1
    return (market.price - position.planned_entry) * position.planned_size * direction_multiplier


def _validate_ai_action(
    state: ExecutionStateResponse,
    market: MarketSnapshot,
    action: str,
) -> None:
    """硬风险边界只做拒绝校验，不替 AI 生成或覆盖动作。"""
    position = state.position
    final_target = position.take_profit[-1]
    if position.direction == "LONG":
        boundary_reached = market.price <= position.stop_loss or market.price >= final_target
    else:
        boundary_reached = market.price >= position.stop_loss or market.price <= final_target
    if boundary_reached and action != "EXIT":
        raise AIDecisionUnavailable("AI 持仓决策未通过止盈止损边界校验，请重新生成")


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
    if not states:
        return []
    news_items = await asyncio.to_thread(get_news)
    market_results = await asyncio.gather(*(
        asyncio.gather(
            get_live_market(state.position.symbol, state.decision.analysis.platform),
            get_candles(
                state.position.symbol,
                state.decision.timeframe,
                220,
                state.decision.analysis.platform,
            ),
        )
        for state in states
    ))
    prepared = []
    for state, (market, candles) in zip(states, market_results, strict=True):
        if market is None:
            continue
        indicators = calculate_technical_indicators(candles)
        if indicators.atr_percent is not None:
            market = market.model_copy(update={"volatility": indicators.atr_percent})
        prepared.append((state, market, indicators))

    contexts = [{
        "symbol": state.position.symbol,
        "platform": state.decision.analysis.platform,
        "timeframe": state.decision.timeframe,
        "market": market.model_dump(),
        "indicators": indicators.model_dump(),
        "opening_analysis": state.decision.analysis.model_dump(),
        "position": state.position.model_dump(),
        "recent_news": [item.model_dump() for item in news_items[:12]],
    } for state, market, indicators in prepared]
    decisions = await generate_position_decisions_with_openai(contexts)

    results = []
    for state, market, _indicators in prepared:
        decision = decisions[state.position.symbol.upper()]
        _validate_ai_action(state, market, decision.action)
        unrealized = _calculate_unrealized(state, market)
        results.append(await asyncio.to_thread(
            _save_monitor,
            state,
            market,
            decision.action,
            unrealized,
            decision.reason,
            decision.current_score,
        ))
    return results
