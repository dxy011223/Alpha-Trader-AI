import pytest
from datetime import UTC, datetime
from zoneinfo import ZoneInfo
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import trade_records
from app.database import Base
from app.schemas import AnalysisRequest, ExecutionCreate, MarketSnapshot
from app.services import analyze_market


def _execution_payload(platform: str = "hyperliquid", symbol: str = "TEST") -> ExecutionCreate:
    market = MarketSnapshot(
        symbol=symbol,
        price=100,
        change_24h=3,
        volume=2_000_000,
        volatility=2,
        funding_rate=0,
        open_interest=1_000_000,
        source="live",
        platform=platform,
    )
    analysis = analyze_market(
        AnalysisRequest(symbol=symbol, timeframe="4h", platform=platform), market, 10_000
    )
    return ExecutionCreate(analysis=analysis, timeframe="4h", total_amount=10_000)


def test_execution_and_position_are_persisted_and_cancelled(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'records.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(trade_records, "SessionLocal", testing_session)

    created = trade_records.create_execution(_execution_payload())
    reloaded = trade_records.read_active_execution()

    assert reloaded is not None
    assert reloaded.decision.id == created.decision.id
    assert reloaded.position.decision_id == created.decision.id
    assert reloaded.position.planned_size > 0
    assert reloaded.decision.analysis.symbol == "TEST"

    with pytest.raises(RuntimeError, match="同币种决策已在执行中"):
        trade_records.create_execution(_execution_payload())

    cancelled = trade_records.cancel_execution(created.decision.id)
    assert cancelled is not None
    assert cancelled.decision.status == "cancelled"
    assert cancelled.position.status == "cancelled"
    assert trade_records.read_active_execution() is None


def test_three_distinct_decisions_can_be_active(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'three-records.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(trade_records, "SessionLocal", testing_session)

    for symbol in ("AAA", "BBB", "CCC"):
        trade_records.create_execution(_execution_payload(symbol=symbol))

    assert [item.decision.analysis.symbol for item in trade_records.read_active_executions()] == [
        "CCC", "BBB", "AAA",
    ]
    with pytest.raises(RuntimeError, match="最多同时执行 3 个决策"):
        trade_records.create_execution(_execution_payload(symbol="DDD"))


def test_real_fills_create_completed_trade_and_review(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'completed.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(trade_records, "SessionLocal", testing_session)
    wallet = "0x1111111111111111111111111111111111111111"
    created = trade_records.create_execution(_execution_payload(), wallet)
    fill_time = int(datetime.now(UTC).timestamp() * 1000) + 1_000
    fills = [
        {"coin": "TEST", "dir": "Open Long", "side": "B", "px": "100", "sz": "1", "fee": "0.10", "closedPnl": "0", "time": fill_time},
        {"coin": "TEST", "dir": "Close Long", "side": "A", "px": "110", "sz": "1", "fee": "0.10", "closedPnl": "10", "time": fill_time + 1_000},
    ]

    completed = trade_records.finalize_position(created.position.id, fills)

    assert completed.trade.closed_at.tzinfo is UTC
    assert completed.trade.entry_price == 100
    assert completed.trade.exit_price == 110
    assert completed.trade.fee == 0.2
    assert completed.trade.gross_pnl == 10
    assert completed.trade.net_pnl == 9.8
    assert completed.trade.entry_source == "hyperliquid"
    assert completed.review.result == "win"
    assert completed.review.metrics["net_pnl"] == 9.8
    assert completed.review.metrics["analysis_engine"] == "facts"
    assert completed.review.adjustments == ["AI 分析暂不可用，本次仅保留已核验交易事实。"]
    assert trade_records.read_active_execution() is None
    assert len(trade_records.list_completed_trades()) == 1
    assert len(trade_records.list_review_records()) == 1

    review_date = completed.trade.closed_at.astimezone(ZoneInfo("Asia/Shanghai")).date()
    daily = trade_records.generate_daily_review(review_date)
    duplicate = trade_records.generate_daily_review(review_date)
    assert daily.id == duplicate.id
    assert daily.metrics["total"] == 1
    assert daily.metrics["net_pnl"] == 9.8

    enriched = completed.review.model_copy(update={
        "summary": "AI 复盘已生成",
        "metrics": {**completed.review.metrics, "analysis_engine": "openai"},
    })
    saved = trade_records.update_review_content(enriched)
    assert saved.summary == "AI 复盘已生成"
    stored_trade_review = next(
        item for item in trade_records.list_review_records() if item.id == completed.review.id
    )
    assert stored_trade_review.metrics["analysis_engine"] == "openai"


def test_binance_trade_and_review_are_filtered_by_platform(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'binance-records.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(trade_records, "SessionLocal", testing_session)

    created = trade_records.create_execution(
        _execution_payload("binance"), "binance:abcd…wxyz"
    )
    started_at = created.position.created_at
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=UTC)
    started_ms = int(started_at.timestamp() * 1000)
    completed = trade_records.finalize_position(created.position.id, [
        {
            "coin": "TEST", "side": "B", "px": "100", "sz": "1",
            "fee": "0.1", "closedPnl": "0", "time": started_ms + 1_000,
        },
        {
            "coin": "TEST", "side": "A", "px": "110", "sz": "1",
            "fee": "0.1", "closedPnl": "10", "time": started_ms + 2_000,
        },
    ])

    assert completed.trade.platform == "binance"
    assert completed.trade.entry_source == "binance"
    assert completed.trade.exit_source == "binance"
    assert completed.review.metrics["platform"] == "binance"
    assert len(trade_records.list_completed_trades(platform="binance")) == 1
    assert trade_records.list_completed_trades(platform="hyperliquid") == []
    assert len(trade_records.list_review_records(platform="binance")) == 1
    assert trade_records.list_review_records(platform="okx") == []


def test_completion_requires_real_open_fill(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'missing-open.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(trade_records, "SessionLocal", testing_session)
    created = trade_records.create_execution(
        _execution_payload(), "0x1111111111111111111111111111111111111111"
    )
    started_ms = int(created.position.created_at.replace(tzinfo=UTC).timestamp() * 1000)

    with pytest.raises(RuntimeError, match="真实开仓成交"):
        trade_records.finalize_position(created.position.id, [{
            "coin": "TEST", "dir": "Close Long", "side": "A", "px": "110",
            "sz": "1", "fee": "0.1", "closedPnl": "10", "time": started_ms + 1_000,
        }])


def test_completion_rejects_unconverted_fee_currency(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'fee-currency.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(trade_records, "SessionLocal", testing_session)
    created = trade_records.create_execution(_execution_payload("binance"), "binance:test")
    started_ms = int(created.position.created_at.replace(tzinfo=UTC).timestamp() * 1000)
    fills = [
        {"coin": "TEST", "side": "B", "px": "100", "sz": "1", "fee": "0.01", "feeCurrency": "BNB", "closedPnl": "0", "time": started_ms + 1_000},
        {"coin": "TEST", "side": "A", "px": "110", "sz": "1", "fee": "0.01", "feeCurrency": "BNB", "closedPnl": "10", "time": started_ms + 2_000},
    ]

    with pytest.raises(RuntimeError, match="手续费币种"):
        trade_records.finalize_position(created.position.id, fills)


def test_hedge_mode_excludes_opposite_position_fees(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'hedge-fees.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(trade_records, "SessionLocal", testing_session)
    created = trade_records.create_execution(_execution_payload("binance"), "binance:test")
    started_ms = int(created.position.created_at.replace(tzinfo=UTC).timestamp() * 1000)
    fills = [
        {"coin": "TEST", "side": "B", "positionSide": "LONG", "px": "100", "sz": "1", "fee": "0.1", "closedPnl": "0", "time": started_ms + 1_000},
        {"coin": "TEST", "side": "A", "positionSide": "SHORT", "px": "101", "sz": "1", "fee": "0.2", "closedPnl": "0", "time": started_ms + 1_100},
        {"coin": "TEST", "side": "B", "positionSide": "SHORT", "px": "99", "sz": "1", "fee": "0.2", "closedPnl": "2", "time": started_ms + 1_200},
        {"coin": "TEST", "side": "A", "positionSide": "LONG", "px": "110", "sz": "1", "fee": "0.1", "closedPnl": "10", "time": started_ms + 1_300},
    ]

    completed = trade_records.finalize_position(created.position.id, fills)

    assert completed.trade.fee == 0.2
    assert completed.trade.gross_pnl == 10
    assert completed.trade.net_pnl == 9.8
