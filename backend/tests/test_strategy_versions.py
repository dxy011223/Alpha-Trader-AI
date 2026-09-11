from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import strategy_versions
from app.database import Base
from app.schemas import ReviewRecordResponse


def test_daily_performance_is_idempotent_before_minimum_sample(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'strategy.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(strategy_versions, "SessionLocal", testing_session)
    review = ReviewRecordResponse.model_validate({
        "id": 1,
        "trade_id": None,
        "review_type": "daily",
        "review_date": "2026-09-11",
        "result": "loss",
        "summary": "测试",
        "findings": [],
        "adjustments": [],
        "metrics": {"platform": "hyperliquid", "total": 5, "wins": 1, "net_pnl": -10},
        "created_at": "2026-09-11T00:00:00Z",
    })

    assert strategy_versions.record_daily_performance(review) == "v1"
    assert strategy_versions.record_daily_performance(review) == "v1"
    version, parameters = strategy_versions.read_current_strategy()
    assert version == "v1"
    assert parameters["min_trade_score"] == 70
