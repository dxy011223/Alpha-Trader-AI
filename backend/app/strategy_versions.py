from datetime import UTC, datetime

from sqlalchemy import select

from app.database import SessionLocal
from app.models import StrategyVersion
from app.schemas import ReviewRecordResponse


DEFAULT_PARAMETERS = {
    "min_trade_score": 70,
    "trend_weight": 30,
    "structure_weight": 25,
    "capital_weight": 20,
    "macro_weight": 15,
    "news_weight": 10,
}


def read_current_strategy() -> tuple[str, dict]:
    with SessionLocal.begin() as session:
        record = session.scalar(
            select(StrategyVersion).order_by(StrategyVersion.id.desc()).limit(1)
        )
        if record is None:
            record = StrategyVersion(
                version="v1",
                parameters=DEFAULT_PARAMETERS,
                performance={"daily_reviews": []},
            )
            session.add(record)
            session.flush()
        return record.version, dict(record.parameters)


def record_daily_performance(review: ReviewRecordResponse) -> str:
    """记录日复盘；样本足够时仅收紧或恢复企划交易阈值。"""
    with SessionLocal.begin() as session:
        current = session.scalar(
            select(StrategyVersion).order_by(StrategyVersion.id.desc()).limit(1)
        )
        if current is None:
            current = StrategyVersion(
                version="v1", parameters=DEFAULT_PARAMETERS, performance={"daily_reviews": []}
            )
            session.add(current)
            session.flush()
        performance = dict(current.performance or {})
        reviews = list(performance.get("daily_reviews") or [])
        review_key = f"{review.review_date}:{review.metrics.get('platform', 'hyperliquid')}"
        if any(item.get("key") == review_key for item in reviews):
            return current.version
        reviews.append({
            "key": review_key,
            "total": int(review.metrics.get("total") or 0),
            "wins": int(review.metrics.get("wins") or 0),
            "net_pnl": float(review.metrics.get("net_pnl") or 0),
        })
        current.performance = {"daily_reviews": reviews[-90:], "updated_at": datetime.now(UTC).isoformat()}
        sample_total = sum(item["total"] for item in reviews)
        if sample_total < 20:
            return current.version
        win_rate = sum(item["wins"] for item in reviews) / sample_total * 100
        previous_threshold = int(current.parameters.get("min_trade_score", 70))
        next_threshold = min(80, previous_threshold + 2) if win_rate < 45 else max(70, previous_threshold - 1)
        if next_threshold == previous_threshold:
            return current.version
        version = f"v{current.id + 1}"
        session.add(StrategyVersion(
            version=version,
            parameters={**current.parameters, "min_trade_score": next_threshold},
            performance={
                "source_version": current.version,
                "sample_total": sample_total,
                "win_rate": round(win_rate, 4),
                "reason": "低胜率收紧阈值" if next_threshold > previous_threshold else "表现恢复，逐步回归企划阈值",
                "daily_reviews": [],
            },
        ))
        return version
