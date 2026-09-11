from datetime import UTC, datetime

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app import simulation_wallet
from app.database import Base
from app.schemas import AnalysisRequest, MarketSnapshot, SimulatedActiveTradePayload, SimulatedCompletedTradePayload, SimulationWalletUpdate
from app.services import analyze_market


CLIENT_ID = "device_test_12345678"


def _analysis():
    market = MarketSnapshot(
        symbol="TEST",
        price=100,
        change_24h=3,
        volume=2_000_000,
        volatility=2,
        funding_rate=0,
        open_interest=1_000_000,
        source="live",
        platform="hyperliquid",
    )
    return analyze_market(AnalysisRequest(symbol="TEST", timeframe="4h"), market, 1_000)


def test_simulation_wallet_read_returns_default_without_creating_a_row(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'simulation-default.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(simulation_wallet, "SessionLocal", testing_session)

    saved = simulation_wallet.read_simulation_wallet(CLIENT_ID, "hyperliquid")

    assert saved.client_id == CLIENT_ID
    assert saved.platform == "hyperliquid"
    assert saved.enabled is False
    assert saved.balance == 1_000
    assert saved.activeTrade is None
    assert saved.history == []
    with testing_session() as session:
        assert session.scalar(select(func.count()).select_from(simulation_wallet.SimulationWalletState)) == 0


def test_simulation_wallet_state_is_persisted(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'simulation-state.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(simulation_wallet, "SessionLocal", testing_session)
    analysis = _analysis()
    now = datetime.now(UTC)
    active_trade = SimulatedActiveTradePayload(
        id=-1,
        analysis=analysis,
        timeframe="4h",
        entryPrice=100,
        size=3,
        allocatedAmount=100,
        latestPrice=102,
        unrealizedPnl=6,
        startedAt=int(now.timestamp() * 1_000),
    )
    completed_trade = SimulatedCompletedTradePayload(
        id=-2,
        decision_id=-2,
        position_id=-2,
        wallet_address="SIMULATED",
        symbol="TEST",
        direction="LONG",
        entry_price=100,
        exit_price=108,
        size=3,
        fee=0,
        gross_pnl=24,
        net_pnl=24,
        pnl_percent=24,
        entry_source="plan",
        exit_source="hyperliquid",
        closed_at=now,
        analysis=analysis,
        timeframe="4h",
        started_at=now,
        allocated_amount=100,
        platform="hyperliquid",
        exit_reason="take_profit",
    )
    payload = SimulationWalletUpdate(
        enabled=True,
        balance=1_085.25,
        activeTrade=active_trade,
        history=[completed_trade],
    )

    simulation_wallet.write_simulation_wallet(CLIENT_ID, "hyperliquid", payload)
    reloaded = simulation_wallet.read_simulation_wallet(CLIENT_ID, "hyperliquid")

    assert reloaded.enabled is True
    assert reloaded.balance == 1_085.25
    assert reloaded.activeTrade is not None
    assert reloaded.activeTrade.latestPrice == 102
    assert len(reloaded.history) == 1
    assert reloaded.history[0].exit_reason == "take_profit"
    assert reloaded.history[0].net_pnl == 24


def test_simulation_wallet_state_is_separated_by_platform(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'simulation-platforms.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(simulation_wallet, "SessionLocal", testing_session)

    binance = SimulationWalletUpdate(enabled=True, balance=860)
    simulation_wallet.write_simulation_wallet(CLIENT_ID, "binance", binance)

    saved_binance = simulation_wallet.read_simulation_wallet(CLIENT_ID, "binance")
    saved_hyperliquid = simulation_wallet.read_simulation_wallet(CLIENT_ID, "hyperliquid")

    assert saved_binance.platform == "binance"
    assert saved_binance.enabled is True
    assert saved_binance.balance == 860
    assert saved_hyperliquid.platform == "hyperliquid"
    assert saved_hyperliquid.enabled is False
    assert saved_hyperliquid.balance == 1_000
