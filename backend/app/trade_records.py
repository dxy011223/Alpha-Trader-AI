from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from zoneinfo import ZoneInfo

from app.config import get_settings
from app.database import SessionLocal
from app.models import CompletedTrade, ReviewRecord, TrackedDecision, TrackedPosition
from app.schemas import (
    CompletedTradeResponse,
    CompletionResponse,
    DecisionRecordResponse,
    ExecutionCreate,
    ExecutionStateResponse,
    PositionRecordResponse,
    ReviewRecordResponse,
)


def _decision_platform(decision: TrackedDecision) -> str:
    return str((decision.analysis_snapshot or {}).get("platform") or "hyperliquid")


def _decision_response(record: TrackedDecision) -> DecisionRecordResponse:
    return DecisionRecordResponse(
        id=record.id,
        status=record.status,
        analysis=record.analysis_snapshot,
        timeframe=record.timeframe,
        total_amount=float(record.total_amount),
        allocated_amount=float(record.allocated_amount),
        started_at=record.started_at,
        completed_at=record.completed_at,
    )


def _position_response(record: TrackedPosition) -> PositionRecordResponse:
    return PositionRecordResponse(
        id=record.id,
        decision_id=record.decision_id,
        wallet_address=record.wallet_address,
        symbol=record.symbol,
        direction=record.direction,
        planned_entry=float(record.planned_entry),
        planned_size=float(record.planned_size),
        leverage=record.leverage,
        margin_amount=float(record.margin_amount),
        position_value=float(record.position_value),
        stop_loss=float(record.stop_loss),
        take_profit=[float(value) for value in record.take_profit],
        status=record.status,
        created_at=record.created_at,
        closed_at=record.closed_at,
    )


def _state_response(decision: TrackedDecision, position: TrackedPosition) -> ExecutionStateResponse:
    return ExecutionStateResponse(
        decision=_decision_response(decision),
        position=_position_response(position),
    )


def create_execution(payload: ExecutionCreate, wallet_address: str | None = None) -> ExecutionStateResponse:
    analysis = payload.analysis
    if analysis.direction == "WAIT":
        raise ValueError("等待信号不能开始执行")
    with SessionLocal.begin() as session:
        active_count = session.scalar(
            select(func.count()).select_from(TrackedDecision).where(
                TrackedDecision.status == "active"
            )
        ) or 0
        if active_count >= get_settings().max_active_executions:
            raise RuntimeError(f"最多同时执行 {get_settings().max_active_executions} 个决策")
        active_decisions = session.scalars(
            select(TrackedDecision).where(TrackedDecision.status == "active")
        ).all()
        if any(
            item.symbol.upper() == analysis.symbol.upper()
            and _decision_platform(item) == analysis.platform
            for item in active_decisions
        ):
            raise RuntimeError("该平台的同币种决策已在执行中")

        allocated = Decimal(str(analysis.position_sizing.margin_amount))
        position_value = Decimal(str(analysis.position_sizing.position_value))
        entry_mid = Decimal(str(sum(analysis.entry_range[:2]) / 2))
        planned_size = position_value / entry_mid if entry_mid > 0 else Decimal("0")
        now = datetime.now(UTC)
        decision = TrackedDecision(
            symbol=analysis.symbol,
            timeframe=payload.timeframe,
            direction=analysis.direction,
            confidence=analysis.confidence,
            score=analysis.score,
            analysis_snapshot=analysis.model_dump(mode="json"),
            total_amount=Decimal(str(payload.total_amount)),
            allocated_amount=allocated,
            status="active",
            started_at=now,
        )
        session.add(decision)
        session.flush()
        position = TrackedPosition(
            decision_id=decision.id,
            wallet_address=wallet_address,
            symbol=analysis.symbol,
            direction=analysis.direction,
            planned_entry=entry_mid,
            planned_size=planned_size,
            leverage=analysis.leverage,
            margin_amount=allocated,
            position_value=position_value,
            stop_loss=Decimal(str(analysis.stop_loss)),
            take_profit=analysis.take_profit,
            status="open",
            created_at=now,
        )
        session.add(position)
        session.flush()
        response = _state_response(decision, position)
    return response


def read_active_executions(platform: str | None = None) -> list[ExecutionStateResponse]:
    with SessionLocal() as session:
        decisions = session.scalars(
            select(TrackedDecision)
            .where(TrackedDecision.status == "active")
            .order_by(TrackedDecision.started_at.desc())
        ).all()
        positions = {
            item.decision_id: item
            for item in session.scalars(
                select(TrackedPosition).where(
                    TrackedPosition.decision_id.in_([decision.id for decision in decisions])
                )
            ).all()
        } if decisions else {}
        return [
            _state_response(decision, positions[decision.id])
            for decision in decisions
            if decision.id in positions
            and (platform is None or _decision_platform(decision) == platform)
        ]


def read_active_execution(platform: str | None = None) -> ExecutionStateResponse | None:
    executions = read_active_executions(platform)
    return executions[0] if executions else None


def read_open_position(position_id: int) -> ExecutionStateResponse | None:
    with SessionLocal() as session:
        position = session.get(TrackedPosition, position_id)
        if position is None or position.status != "open":
            return None
        decision = session.get(TrackedDecision, position.decision_id)
        if decision is None:
            return None
        return _state_response(decision, position)


def attach_wallet_to_active_position(address: str, platform: str = "hyperliquid") -> None:
    with SessionLocal.begin() as session:
        positions = session.scalars(
            select(TrackedPosition).where(TrackedPosition.status == "open")
        ).all()
        for position in positions:
            decision = session.get(TrackedDecision, position.decision_id)
            if decision is not None and _decision_platform(decision) == platform:
                position.wallet_address = address.lower() if platform == "hyperliquid" else address


def cancel_execution(decision_id: int) -> ExecutionStateResponse | None:
    with SessionLocal.begin() as session:
        decision = session.get(TrackedDecision, decision_id)
        if decision is None or decision.status != "active":
            return None
        position = session.scalar(
            select(TrackedPosition).where(TrackedPosition.decision_id == decision.id)
        )
        if position is None:
            return None
        now = datetime.now(UTC)
        decision.status = "cancelled"
        decision.completed_at = now
        position.status = "cancelled"
        position.closed_at = now
        session.flush()
        return _state_response(decision, position)


def _trade_response(
    trade: CompletedTrade, decision: TrackedDecision
) -> CompletedTradeResponse:
    return CompletedTradeResponse(
        id=trade.id,
        decision_id=trade.decision_id,
        position_id=trade.position_id,
        wallet_address=trade.wallet_address,
        symbol=trade.symbol,
        direction=trade.direction,
        entry_price=float(trade.entry_price),
        exit_price=float(trade.exit_price),
        size=float(trade.size),
        fee=float(trade.fee),
        gross_pnl=float(trade.gross_pnl),
        net_pnl=float(trade.net_pnl),
        pnl_percent=trade.pnl_percent,
        entry_source=trade.entry_source,
        exit_source=trade.exit_source,
        closed_at=trade.closed_at,
        analysis=decision.analysis_snapshot,
        timeframe=decision.timeframe,
        started_at=decision.started_at,
        allocated_amount=float(decision.allocated_amount),
        platform=_decision_platform(decision),
    )


def _review_response(review: ReviewRecord) -> ReviewRecordResponse:
    return ReviewRecordResponse(
        id=review.id,
        trade_id=review.trade_id,
        review_type=review.review_type,
        review_date=review.review_date,
        result=review.result,
        summary=review.summary,
        findings=review.findings,
        adjustments=review.adjustments,
        metrics=review.metrics,
        created_at=review.created_at,
    )


def _decimal(fill: dict, key: str) -> Decimal:
    try:
        return Decimal(str(fill.get(key) or "0"))
    except Exception as exc:
        raise ValueError(f"成交字段 {key} 格式无效") from exc


def _weighted_price(fills: list[dict]) -> Decimal:
    size = sum((_decimal(fill, "sz") for fill in fills), Decimal("0"))
    if size <= 0:
        raise ValueError("真实成交数量无效")
    return sum((_decimal(fill, "px") * _decimal(fill, "sz") for fill in fills), Decimal("0")) / size


def _is_close_fill(fill: dict, direction: str, platform: str) -> bool:
    fill_direction = str(fill.get("dir") or "").lower()
    expected_side = "A" if direction == "LONG" else "B"
    if platform != "hyperliquid":
        position_side = str(fill.get("positionSide") or "BOTH").upper()
        expected_position_side = direction.upper()
        return str(fill.get("side") or "") == expected_side and position_side in {
            "BOTH", "NET", expected_position_side,
        }
    return str(fill.get("side") or "") == expected_side and (
        "close" in fill_direction or ">" in fill_direction or _decimal(fill, "closedPnl") != 0
    )


def _is_open_fill(fill: dict, direction: str, platform: str) -> bool:
    if platform == "hyperliquid":
        open_name = "open long" if direction == "LONG" else "open short"
        return open_name in str(fill.get("dir") or "").lower()
    expected_side = "B" if direction == "LONG" else "A"
    position_side = str(fill.get("positionSide") or "BOTH").upper()
    return str(fill.get("side") or "") == expected_side and position_side in {
        "BOTH", "NET", direction.upper(),
    }


def _first_flat_time(fills: list[dict]) -> int | None:
    for fill in sorted(fills, key=lambda item: int(item.get("time") or 0)):
        if "startPosition" not in fill:
            continue
        start_position = _decimal(fill, "startPosition")
        size = _decimal(fill, "sz")
        signed_size = size if str(fill.get("side") or "") == "B" else -size
        if abs(start_position + signed_size) <= Decimal("0.00000001"):
            return int(fill.get("time") or 0)
    return None


def _build_trade_review(
    trade: CompletedTrade, decision: TrackedDecision
) -> ReviewRecord:
    analysis = decision.analysis_snapshot
    planned_max_loss = Decimal(str(analysis.get("position_sizing", {}).get("max_loss_amount") or 0))
    risk_multiple = float(trade.net_pnl / planned_max_loss) if planned_max_loss > 0 else 0.0
    result = "win" if trade.net_pnl > 0 else "loss" if trade.net_pnl < 0 else "breakeven"
    fee_share = float(trade.fee / abs(trade.gross_pnl) * 100) if trade.gross_pnl else 0.0
    findings = [
        f"真实退出均价 {float(trade.exit_price):,.6f}，净盈亏 {float(trade.net_pnl):+,.2f} USDC。",
        f"本次共产生手续费 {float(trade.fee):,.4f} USDC，占毛盈亏绝对值 {fee_share:.2f}%。",
        f"相对计划最大亏损，本次结果为 {risk_multiple:+.2f}R。",
    ]
    adjustments = []
    if trade.entry_source == "plan":
        adjustments.append("未检索到决策开始后的开仓成交，下次应在实际开仓前启动跟踪。")
    if fee_share >= 10:
        adjustments.append("手续费占比较高，后续应减少碎片化成交并评估限价单。")
    if result == "loss" and risk_multiple < -1.05:
        adjustments.append("实际亏损超过计划风险预算，需要核查止损执行偏差。")
    if not adjustments:
        adjustments.append("执行结果与计划风险边界一致，继续保留当前仓位计算规则。")
    return ReviewRecord(
        trade_id=trade.id,
        review_type="trade",
        review_date=trade.closed_at.astimezone(ZoneInfo("Asia/Shanghai")).date(),
        result=result,
        summary=f"{trade.symbol} {trade.direction} 已按 {_decision_platform(decision)} 真实成交完成复盘。",
        findings=findings,
        adjustments=adjustments,
        metrics={
            "entry_price": float(trade.entry_price),
            "exit_price": float(trade.exit_price),
            "size": float(trade.size),
            "fee": float(trade.fee),
            "gross_pnl": float(trade.gross_pnl),
            "net_pnl": float(trade.net_pnl),
            "pnl_percent": trade.pnl_percent,
            "risk_multiple": round(risk_multiple, 4),
            "platform": _decision_platform(decision),
            "analysis_engine": "rules",
            "analysis_model": None,
        },
    )


def finalize_position(position_id: int, fills: list[dict]) -> CompletionResponse:
    with SessionLocal.begin() as session:
        position = session.get(TrackedPosition, position_id)
        if position is None or position.status != "open":
            raise LookupError("没有找到执行中的计划持仓")
        decision = session.get(TrackedDecision, position.decision_id)
        if decision is None or decision.status != "active":
            raise LookupError("对应决策不在执行状态")
        if not position.wallet_address:
            raise RuntimeError("请先连接当前平台的只读账户")

        platform = _decision_platform(decision)

        started_at = position.created_at
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=UTC)
        started_ms = int(started_at.timestamp() * 1000)
        relevant = [
            fill for fill in fills
            if str(fill.get("coin") or "").upper() == position.symbol.upper()
            and int(fill.get("time") or 0) >= started_ms
        ]
        flat_time = _first_flat_time(relevant)
        if flat_time is not None:
            relevant = [fill for fill in relevant if int(fill.get("time") or 0) <= flat_time]
        close_fills = [
            fill for fill in relevant if _is_close_fill(fill, position.direction, platform)
        ]
        if not close_fills:
            raise RuntimeError("未找到决策开始后的真实平仓成交")

        open_fills = [
            fill for fill in relevant if _is_open_fill(fill, position.direction, platform)
        ]
        if not open_fills:
            raise RuntimeError("未找到决策开始后的真实开仓成交，不能使用计划价格替代")
        trade_fills = sorted(
            [*open_fills, *close_fills], key=lambda fill: int(fill.get("time") or 0)
        )
        unsupported_fee_currencies = {
            str(fill.get("feeCurrency") or "USDC").upper()
            for fill in trade_fills
            if str(fill.get("feeCurrency") or "USDC").upper() not in {"USDT", "USDC"}
        }
        if unsupported_fee_currencies:
            raise RuntimeError("手续费币种不是 USDT/USDC，暂不能准确换算净盈亏")
        entry_price = _weighted_price(open_fills)
        entry_source = platform
        exit_price = _weighted_price(close_fills)
        size = sum((_decimal(fill, "sz") for fill in close_fills), Decimal("0"))
        fee = sum((_decimal(fill, "fee") for fill in trade_fills), Decimal("0"))
        gross_pnl = sum((_decimal(fill, "closedPnl") for fill in close_fills), Decimal("0"))
        net_pnl = gross_pnl - fee
        notional = entry_price * size
        pnl_percent = float(net_pnl / notional * 100) if notional > 0 else 0.0
        closed_ms = max(int(fill.get("time") or 0) for fill in close_fills)
        closed_at = datetime.fromtimestamp(closed_ms / 1000, tz=UTC)

        trade = CompletedTrade(
            decision_id=decision.id,
            position_id=position.id,
            wallet_address=position.wallet_address,
            symbol=position.symbol,
            direction=position.direction,
            entry_price=entry_price,
            exit_price=exit_price,
            size=size,
            fee=fee,
            gross_pnl=gross_pnl,
            net_pnl=net_pnl,
            pnl_percent=round(pnl_percent, 6),
            entry_source=entry_source,
            exit_source=platform,
            exchange_fills=trade_fills,
            closed_at=closed_at,
        )
        session.add(trade)
        session.flush()
        review = _build_trade_review(trade, decision)
        session.add(review)
        decision.status = "completed"
        decision.completed_at = closed_at
        position.status = "completed"
        position.closed_at = closed_at
        session.flush()
        return CompletionResponse(
            trade=_trade_response(trade, decision),
            review=_review_response(review),
        )


def list_completed_trades(
    limit: int = 100, platform: str | None = None
) -> list[CompletedTradeResponse]:
    with SessionLocal() as session:
        trades = session.scalars(
            select(CompletedTrade).order_by(CompletedTrade.closed_at.desc())
        ).all()
        decisions = {
            decision.id: decision
            for decision in session.scalars(
                select(TrackedDecision).where(
                    TrackedDecision.id.in_([trade.decision_id for trade in trades])
                )
            ).all()
        } if trades else {}
        responses = [
            _trade_response(trade, decisions[trade.decision_id]) for trade in trades
            if trade.decision_id in decisions
            and (platform is None or _decision_platform(decisions[trade.decision_id]) == platform)
        ]
        return responses[:limit]


def list_review_records(
    limit: int = 100, platform: str | None = None
) -> list[ReviewRecordResponse]:
    with SessionLocal() as session:
        records = session.scalars(
            select(ReviewRecord).order_by(ReviewRecord.created_at.desc())
        ).all()
        if platform is None:
            return [_review_response(record) for record in records[:limit]]
        trade_ids = [record.trade_id for record in records if record.trade_id is not None]
        trades = {
            trade.id: trade
            for trade in session.scalars(
                select(CompletedTrade).where(CompletedTrade.id.in_(trade_ids))
            ).all()
        } if trade_ids else {}
        decision_ids = [trade.decision_id for trade in trades.values()]
        decisions = {
            decision.id: decision
            for decision in session.scalars(
                select(TrackedDecision).where(TrackedDecision.id.in_(decision_ids))
            ).all()
        } if decision_ids else {}
        filtered = []
        for record in records:
            if record.trade_id is None:
                record_platform = str((record.metrics or {}).get("platform") or "hyperliquid")
            else:
                trade = trades.get(record.trade_id)
                decision = decisions.get(trade.decision_id) if trade else None
                record_platform = _decision_platform(decision) if decision else "hyperliquid"
            if record_platform == platform:
                filtered.append(_review_response(record))
        return filtered[:limit]


def update_review_content(review: ReviewRecordResponse) -> ReviewRecordResponse:
    """只更新复盘解释文本与引擎标记，不允许改写真实成交记录。"""
    with SessionLocal.begin() as session:
        record = session.get(ReviewRecord, review.id)
        if record is None:
            raise LookupError("没有找到需要更新的复盘记录")
        record.summary = review.summary
        record.findings = review.findings
        record.adjustments = review.adjustments
        record.metrics = review.metrics
        session.flush()
        return _review_response(record)


def generate_daily_review(
    target_date: date, platform: str = "hyperliquid"
) -> ReviewRecordResponse:
    """按北京时间汇总一天内已由真实成交结算的交易，并持久化每日复盘。"""
    shanghai = ZoneInfo("Asia/Shanghai")
    start = datetime.combine(target_date, time.min, tzinfo=shanghai).astimezone(UTC)
    end = (datetime.combine(target_date, time.min, tzinfo=shanghai) + timedelta(days=1)).astimezone(UTC)
    with SessionLocal.begin() as session:
        existing_records = session.scalars(
            select(ReviewRecord).where(
                ReviewRecord.review_type == "daily",
                ReviewRecord.review_date == target_date,
            )
        ).all()
        existing = next(
            (
                item for item in existing_records
                if str((item.metrics or {}).get("platform") or "hyperliquid") == platform
            ),
            None,
        )
        all_trades = session.scalars(
            select(CompletedTrade).where(
                CompletedTrade.closed_at >= start,
                CompletedTrade.closed_at < end,
            )
        ).all()
        decisions = {
            decision.id: decision
            for decision in session.scalars(
                select(TrackedDecision).where(
                    TrackedDecision.id.in_([trade.decision_id for trade in all_trades])
                )
            ).all()
        } if all_trades else {}
        trades = [
            trade for trade in all_trades
            if trade.decision_id in decisions
            and _decision_platform(decisions[trade.decision_id]) == platform
        ]
        total = len(trades)
        wins = sum(trade.net_pnl > 0 for trade in trades)
        losses = sum(trade.net_pnl < 0 for trade in trades)
        fees = sum((trade.fee for trade in trades), Decimal("0"))
        net_pnl = sum((trade.net_pnl for trade in trades), Decimal("0"))
        win_rate = wins / total * 100 if total else 0.0
        result = "no_trades" if not trades else "win" if net_pnl > 0 else "loss" if net_pnl < 0 else "breakeven"
        findings = [
            f"当日完成 {total} 笔真实交易，胜率 {win_rate:.1f}%。",
            f"净盈亏 {float(net_pnl):+,.2f} USDC，手续费合计 {float(fees):,.4f} USDC。",
        ]
        adjustments = []
        if not trades:
            adjustments.append("当日没有完成交易，不调整策略参数。")
        elif win_rate < 50:
            adjustments.append("当日胜率低于 50%，下一交易日降低总风险敞口并复核入场条件。")
        elif fees > abs(net_pnl) * Decimal("0.1"):
            adjustments.append("手续费占比较高，下一交易日减少不必要的分批成交。")
        else:
            adjustments.append("当日执行与风险边界稳定，保留当前仓位规则并继续观察。")

        review = existing or ReviewRecord(
            trade_id=None,
            review_type="daily",
            review_date=target_date,
        )
        review.result = result
        review.summary = f"{target_date.isoformat()} {platform} 每日真实交易复盘"
        review.findings = findings
        review.adjustments = adjustments
        review.metrics = {
                "total": total,
                "wins": wins,
                "losses": losses,
                "win_rate": round(win_rate, 4),
                "fees": float(fees),
                "net_pnl": float(net_pnl),
                "analysis_engine": "rules",
                "analysis_model": None,
                "platform": platform,
            }
        if existing is None:
            session.add(review)
        session.flush()
        return _review_response(review)
