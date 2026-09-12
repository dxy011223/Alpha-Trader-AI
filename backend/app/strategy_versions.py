from datetime import UTC, datetime

from sqlalchemy import select

from app.database import SessionLocal
from app.models import CompletedTrade, ReviewRecord, StrategyVersion, TrackedDecision
from app.schemas import ReviewRecordResponse, StrategyVersionResponse
from app.strategy_scoring import (
    DEFAULT_PARAMETERS,
    SCORE_FACTORS,
    WEIGHT_LIMITS,
    normalize_strategy_parameters,
    read_strategy_weights,
)


MINIMUM_SAMPLE_SIZE = 20
HISTORY_LIMIT = 100
MAXIMUM_WEIGHT_CHANGE = 3
MAXIMUM_THRESHOLD_CHANGE = 2
FACTOR_LABELS = {
    "trend": "趋势",
    "structure": "技术结构",
    "capital": "资金",
    "macro": "宏观",
    "news": "新闻",
}


def _read_or_create_current_strategy(session) -> StrategyVersion:
    record = session.scalar(
        select(StrategyVersion).order_by(StrategyVersion.id.desc()).limit(1)
    )
    if record is None:
        record = StrategyVersion(
            version="v1",
            parameters=dict(DEFAULT_PARAMETERS),
            performance={"daily_reviews": []},
        )
        session.add(record)
        session.flush()
    return record


def read_current_strategy() -> tuple[str, dict]:
    with SessionLocal.begin() as session:
        record = _read_or_create_current_strategy(session)
        return record.version, normalize_strategy_parameters(record.parameters)


def list_strategy_versions(limit: int = 20) -> list[StrategyVersionResponse]:
    """按时间倒序读取策略版本，供复盘页面展示完整演进记录。"""
    with SessionLocal.begin() as session:
        records = session.scalars(
            select(StrategyVersion).order_by(StrategyVersion.id.desc()).limit(limit)
        ).all()
        return [
            StrategyVersionResponse(
                version=record.version,
                parameters=normalize_strategy_parameters(record.parameters),
                performance=dict(record.performance or {}),
                created_at=record.created_at,
            )
            for record in records
        ]


def _recent_strategy_samples(session, strategy_version: str) -> list[dict]:
    statement = (
        select(CompletedTrade, TrackedDecision)
        .join(TrackedDecision, TrackedDecision.id == CompletedTrade.decision_id)
        .order_by(CompletedTrade.closed_at.desc())
        .execution_options(yield_per=200)
    )
    samples = []
    for trade, decision in session.execute(statement):
        snapshot = dict(decision.analysis_snapshot or {})
        # 旧决策快照没有结构化版本字段，均属于初始 v1 策略。
        if str(snapshot.get("strategy_version") or "v1") != strategy_version:
            continue
        samples.append({
            "trade_id": trade.id,
            "symbol": trade.symbol,
            "direction": trade.direction,
            "net_pnl": float(trade.net_pnl),
            "pnl_percent": float(trade.pnl_percent),
            "score": int(decision.score),
            "score_breakdown": dict(snapshot.get("score_breakdown") or {}),
            "strategy_parameters": dict(snapshot.get("strategy_parameters") or {}),
            "closed_at": trade.closed_at.isoformat(),
        })
        if len(samples) >= HISTORY_LIMIT:
            break
    return samples


def _factor_performance(samples: list[dict]) -> dict[str, dict[str, float]]:
    groups = {
        "wins": [sample for sample in samples if sample["net_pnl"] > 0],
        "losses": [sample for sample in samples if sample["net_pnl"] < 0],
    }
    result = {}
    for factor in SCORE_FACTORS:
        averages = {}
        for group_name, group_samples in groups.items():
            ratios = []
            for sample in group_samples:
                breakdown = sample["score_breakdown"]
                if factor not in breakdown:
                    continue
                sample_weights = read_strategy_weights(sample["strategy_parameters"])
                ratio = float(breakdown[factor]) / sample_weights[factor]
                ratios.append(max(0.0, min(1.0, ratio)))
            averages[group_name] = sum(ratios) / len(ratios) if ratios else 0.0
        result[factor] = {
            "win_average": round(averages["wins"] * 100, 2),
            "loss_average": round(averages["losses"] * 100, 2),
            "loss_gap": round((averages["losses"] - averages["wins"]) * 100, 2),
        }
    return result


def _symbol_performance(samples: list[dict]) -> list[dict]:
    symbols: dict[str, list[dict]] = {}
    for sample in samples:
        symbols.setdefault(sample["symbol"], []).append(sample)
    result = []
    for symbol, symbol_samples in symbols.items():
        wins = sum(sample["net_pnl"] > 0 for sample in symbol_samples)
        losses = sum(sample["net_pnl"] < 0 for sample in symbol_samples)
        result.append({
            "symbol": symbol,
            "total": len(symbol_samples),
            "wins": wins,
            "losses": losses,
            "win_rate": round(wins / len(symbol_samples) * 100, 4),
            "net_pnl": round(sum(sample["net_pnl"] for sample in symbol_samples), 8),
        })
    return sorted(result, key=lambda item: item["total"], reverse=True)


def build_strategy_optimization_context(review: ReviewRecordResponse) -> dict:
    """只整理已核验事实，供 AI 完成复盘解释和策略优化判断。"""
    if review.review_type != "daily":
        raise ValueError("只有每日复盘可以生成策略优化上下文")
    with SessionLocal.begin() as session:
        current = _read_or_create_current_strategy(session)
        current_version = current.version
        parameters = normalize_strategy_parameters(current.parameters)
        samples = _recent_strategy_samples(session, current_version)
    wins = sum(sample["net_pnl"] > 0 for sample in samples)
    losses = sum(sample["net_pnl"] < 0 for sample in samples)
    return {
        "review_date": review.review_date.isoformat(),
        "current_version": current_version,
        "current_parameters": parameters,
        "sample_total": len(samples),
        "sample_limit": HISTORY_LIMIT,
        "minimum_sample_size": MINIMUM_SAMPLE_SIZE,
        "wins": wins,
        "losses": losses,
        "breakeven": len(samples) - wins - losses,
        "win_rate": round(wins / len(samples) * 100, 4) if samples else 0.0,
        "net_pnl": round(sum(sample["net_pnl"] for sample in samples), 8),
        "factor_performance": _factor_performance(samples),
        "symbol_performance": _symbol_performance(samples),
        "verified_trades": samples,
        "safety_constraints": {
            "weights_must_total": 100,
            "weight_limits": WEIGHT_LIMITS,
            "maximum_weight_change_per_review": MAXIMUM_WEIGHT_CHANGE,
            "min_trade_score_range": [70, 80],
            "maximum_threshold_change_per_review": MAXIMUM_THRESHOLD_CHANGE,
            "automatic_trading_allowed": False,
        },
    }


def _parameter_changes(before: dict, after: dict) -> list[str]:
    changes = []
    if before["min_trade_score"] != after["min_trade_score"]:
        changes.append(
            f"可交易阈值 {before['min_trade_score']}→{after['min_trade_score']}"
        )
    for factor in SCORE_FACTORS:
        key = f"{factor}_weight"
        if before[key] != after[key]:
            changes.append(
                f"{FACTOR_LABELS[factor]}权重 {before[key]}→{after[key]}"
            )
    return changes


def _validate_ai_proposal(
    proposal: dict, current_parameters: dict, sample_total: int
) -> tuple[dict | None, str | None]:
    if not isinstance(proposal, dict):
        return None, "AI 未返回可解析的策略优化方案"
    if not proposal.get("should_update"):
        return current_parameters, None
    if sample_total < MINIMUM_SAMPLE_SIZE:
        return None, f"真实交易样本少于 {MINIMUM_SAMPLE_SIZE} 笔"
    raw_parameters = proposal.get("parameters")
    if not isinstance(raw_parameters, dict):
        return None, "AI 策略参数格式无效"
    required_keys = {
        "min_trade_score",
        *(f"{factor}_weight" for factor in SCORE_FACTORS),
    }
    if set(raw_parameters) != required_keys:
        return None, "AI 策略参数字段不完整"
    if any(isinstance(raw_parameters[key], bool) for key in required_keys):
        return None, "AI 策略参数必须为整数"
    try:
        parameters = {key: int(raw_parameters[key]) for key in required_keys}
    except (TypeError, ValueError):
        return None, "AI 策略参数必须为整数"
    if any(parameters[key] != raw_parameters[key] for key in required_keys):
        return None, "AI 策略参数必须为整数"
    threshold = parameters["min_trade_score"]
    if not 70 <= threshold <= 80:
        return None, "AI 可交易阈值超出 70–80 安全范围"
    if abs(threshold - current_parameters["min_trade_score"]) > MAXIMUM_THRESHOLD_CHANGE:
        return None, "AI 可交易阈值单次变化超过安全限制"
    weights = {factor: parameters[f"{factor}_weight"] for factor in SCORE_FACTORS}
    if sum(weights.values()) != 100:
        return None, "AI 五维权重合计必须为 100"
    for factor, weight in weights.items():
        minimum, maximum = WEIGHT_LIMITS[factor]
        if not minimum <= weight <= maximum:
            return None, f"AI {FACTOR_LABELS[factor]}权重超出安全范围"
        if abs(weight - current_parameters[f"{factor}_weight"]) > MAXIMUM_WEIGHT_CHANGE:
            return None, f"AI {FACTOR_LABELS[factor]}权重单次变化超过安全限制"
    return parameters, None


def _persist_review(session, review: ReviewRecordResponse) -> ReviewRecordResponse:
    record = session.get(ReviewRecord, review.id)
    if record is not None:
        record.summary = review.summary
        record.findings = review.findings
        record.adjustments = review.adjustments
        record.metrics = review.metrics
    return review


def record_daily_performance(review: ReviewRecordResponse) -> ReviewRecordResponse:
    """验证并保存 AI 调参结果；后端不自行生成分析结论或替代方案。"""
    if review.review_type != "daily":
        raise ValueError("只有每日复盘可以触发策略优化")
    review_key = review.review_date.isoformat()
    with SessionLocal.begin() as session:
        current = session.scalar(
            select(StrategyVersion)
            .order_by(StrategyVersion.id.desc())
            .limit(1)
            .with_for_update()
        )
        if current is None:
            current = _read_or_create_current_strategy(session)

        metrics = dict(review.metrics)
        proposal = metrics.pop("ai_strategy_proposal", None)
        existing_optimization = metrics.get("strategy_optimization")
        if not existing_optimization:
            daily_records = session.scalars(
                select(ReviewRecord).where(
                    ReviewRecord.review_type == "daily",
                    ReviewRecord.review_date == review.review_date,
                )
            ).all()
            existing_optimization = next(
                (
                    (record.metrics or {}).get("strategy_optimization")
                    for record in daily_records
                    if isinstance((record.metrics or {}).get("strategy_optimization"), dict)
                ),
                None,
            )
        if (
            isinstance(existing_optimization, dict)
            and existing_optimization.get("review_key") == review_key
        ):
            return _persist_review(
                session,
                review.model_copy(update={
                    "metrics": {**metrics, "strategy_optimization": existing_optimization}
                }),
            )

        performance = dict(current.performance or {})
        reviews = list(performance.get("daily_reviews") or [])
        if not any(item.get("key") == review_key for item in reviews):
            reviews.append({
                "key": review_key,
                "platform": metrics.get("platform", "hyperliquid"),
                "total": int(metrics.get("total") or 0),
                "wins": int(metrics.get("wins") or 0),
                "net_pnl": float(metrics.get("net_pnl") or 0),
            })
        current.performance = {
            **performance,
            "daily_reviews": reviews[-90:],
            "updated_at": datetime.now(UTC).isoformat(),
        }

        samples = _recent_strategy_samples(session, current.version)
        current_parameters = normalize_strategy_parameters(current.parameters)
        next_parameters, rejection_reason = _validate_ai_proposal(
            proposal, current_parameters, len(samples)
        )
        changes = _parameter_changes(
            current_parameters, next_parameters or current_parameters
        )
        version_after = current.version
        if proposal is None:
            status = "ai_unavailable"
        elif rejection_reason:
            status = "rejected"
        elif proposal.get("should_update") and changes:
            version_after = f"v{current.id + 1}"
            session.add(StrategyVersion(
                version=version_after,
                parameters=next_parameters,
                performance={
                    "source_version": current.version,
                    "sample_total": len(samples),
                    "reason": "；".join(proposal.get("error_reasons") or []),
                    "ai_adjustments": proposal.get("adjustments") or [],
                    "analysis_model": metrics.get("analysis_model"),
                    "daily_reviews": [],
                },
            ))
            status = "updated"
        else:
            status = "unchanged" if len(samples) >= MINIMUM_SAMPLE_SIZE else "waiting_samples"

        wins = sum(sample["net_pnl"] > 0 for sample in samples)
        losses = sum(sample["net_pnl"] < 0 for sample in samples)
        optimization = {
            "review_key": review_key,
            "status": status,
            "version_before": current.version,
            "version_after": version_after,
            "sample_total": len(samples),
            "sample_limit": HISTORY_LIMIT,
            "wins": wins,
            "losses": losses,
            "win_rate": round(wins / len(samples) * 100, 4) if samples else 0.0,
            "net_pnl": round(sum(sample["net_pnl"] for sample in samples), 8),
            "changes": changes,
            "error_reasons": (proposal or {}).get("error_reasons", []),
            "ai_adjustments": (proposal or {}).get("adjustments", []),
            "analysis_model": metrics.get("analysis_model"),
            "rejection_reason": rejection_reason,
        }
        return _persist_review(
            session,
            review.model_copy(update={
                "metrics": {**metrics, "strategy_optimization": optimization}
            }),
        )
