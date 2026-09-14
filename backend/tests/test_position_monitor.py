import asyncio

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import position_monitor, trade_records
from app.database import Base
from app.schemas import AnalysisRequest, ExecutionCreate, MarketSnapshot, TechnicalIndicators
from app.services import analyze_market


def test_monitor_persists_take_profit_action(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'monitor.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(trade_records, "SessionLocal", testing_session)
    monkeypatch.setattr(position_monitor, "SessionLocal", testing_session)
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=4, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    analysis = analyze_market(
        AnalysisRequest(symbol="TEST"), market, 10_000,
        TechnicalIndicators(ema20=110, ema50=100, ema200=90),
    )
    created = trade_records.create_execution(
        ExecutionCreate(analysis=analysis, timeframe="4h", total_amount=10_000)
    )

    async def fake_market(_symbol: str, _platform: str):
        return market.model_copy(update={"price": analysis.take_profit[0]})

    monkeypatch.setattr(position_monitor, "get_live_market", fake_market)
    first = asyncio.run(position_monitor.monitor_active_positions())
    second = asyncio.run(position_monitor.monitor_active_positions())

    assert first[0].position_id == created.position.id
    assert first[0].action == "REDUCE"
    assert first[0].opening_score == analysis.score
    assert first[0].current_score == analysis.score
    assert second[0].action == "REDUCE"


def test_monitor_rule_exits_at_hard_boundary(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'score-monitor.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(trade_records, "SessionLocal", testing_session)
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=4, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    analysis = analyze_market(
        AnalysisRequest(symbol="TEST"), market, 10_000,
        TechnicalIndicators(ema20=110, ema50=100, ema200=90),
    )
    state = trade_records.create_execution(
        ExecutionCreate(analysis=analysis, timeframe="4h", total_amount=10_000)
    )

    stopped_market = market.model_copy(update={"price": state.position.stop_loss})
    action, _unrealized, reason = position_monitor._evaluate(state, stopped_market)

    assert action == "EXIT"
    assert "止损" in reason
