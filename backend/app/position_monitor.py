import asyncio
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select

from app.database import SessionLocal
from app.models import PositionMonitorRecord
from app.schemas import AnalysisRequest, AnalysisResponse, ExecutionStateResponse, MarketSnapshot, PositionMonitorResponse
from app.services import analyze_market, calculate_technical_indicators, get_candles, get_live_market
from app.trade_records import read_active_executions


def _evaluate(
    state: ExecutionStateResponse,
    market: MarketSnapshot,
    refreshed: AnalysisResponse | None = None,
) -> tuple[str, float, str]:
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
    if refreshed is not None and refreshed.indicators is not None:
        indicators = refreshed.indicators
        ema_values = (indicators.ema20, indicators.ema50, indicators.ema200)
        if all(value is not None for value in ema_values):
            ema20, ema50, ema200 = ema_values
            current_direction = (
                "LONG" if ema20 > ema50 > ema200
                else "SHORT" if ema20 < ema50 < ema200
                else "WAIT"
            )
            if current_direction not in ("WAIT", position.direction):
                return "EXIT", unrealized, "最新 EMA20/50/200 已形成反向排列，原决策趋势假设失效"
            score_drop = state.decision.analysis.score - refreshed.score
            if current_direction == "WAIT" and score_drop >= 10:
                return "REDUCE", unrealized, f"最新均线方向不明确且评分下降 {score_drop} 分，建议降低风险敞口"
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

    async def load_state_market(state: ExecutionStateResponse):
        return await asyncio.gather(
            get_live_market(state.position.symbol, state.decision.analysis.platform),
            get_candles(
                state.position.symbol,
                state.decision.timeframe,
                220,
                state.decision.analysis.platform,
            ),
        )

    snapshots = await asyncio.gather(*(load_state_market(state) for state in states))
    results = []
    for state, (market, candles) in zip(states, snapshots, strict=True):
        if market is None:
            continue
        indicators = calculate_technical_indicators(candles)
        refreshed = None
        if all(value is not None for value in (indicators.ema20, indicators.ema50, indicators.ema200)):
            if indicators.atr_percent is not None:
                market = market.model_copy(update={"volatility": indicators.atr_percent})
            refreshed = analyze_market(
                AnalysisRequest(
                    symbol=state.position.symbol,
                    timeframe=state.decision.timeframe,
                    platform=state.decision.analysis.platform,
                ),
                market,
                state.decision.total_amount,
                indicators,
                strategy_version=state.decision.analysis.strategy_version,
                strategy_parameters=state.decision.analysis.strategy_parameters,
                history_policy=state.decision.analysis.history_policy,
            )
        action, unrealized, reason = _evaluate(state, market, refreshed)
        results.append(await asyncio.to_thread(
            _save_monitor,
            state,
            market,
            action,
            unrealized,
            reason,
            refreshed.score if refreshed is not None else state.decision.analysis.score,
        ))
    return results
