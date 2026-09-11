from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, JSON, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Position(Base):
    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    direction: Mapped[str] = mapped_column(String(10))
    entry_price: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    size: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    leverage: Mapped[float] = mapped_column(Float)
    stop_loss: Mapped[Decimal | None] = mapped_column(Numeric(20, 8))
    take_profit: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Trade(Base):
    __tablename__ = "trades"

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    entry: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    exit: Mapped[Decimal | None] = mapped_column(Numeric(20, 8))
    profit: Mapped[Decimal | None] = mapped_column(Numeric(20, 8))
    strategy_id: Mapped[int | None] = mapped_column(Integer)
    result: Mapped[str | None] = mapped_column(String(20))


class AIDecision(Base):
    __tablename__ = "ai_decisions"

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    decision: Mapped[str] = mapped_column(String(10))
    confidence: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(Text)
    result: Mapped[str | None] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StrategyVersion(Base):
    __tablename__ = "strategy_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    version: Mapped[str] = mapped_column(String(30), unique=True)
    parameters: Mapped[dict] = mapped_column(JSON)
    performance: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ArchivedNews(Base):
    __tablename__ = "archived_news"
    __table_args__ = (UniqueConstraint("fingerprint", name="uq_archived_news_fingerprint"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    archive_date: Mapped[date] = mapped_column(Date, index=True)
    title: Mapped[str] = mapped_column(String(300))
    source: Mapped[str] = mapped_column(String(100))
    published_at: Mapped[str] = mapped_column(String(50))
    impact: Mapped[int] = mapped_column(Integer)
    assets: Mapped[list] = mapped_column(JSON, default=list)
    direction: Mapped[str] = mapped_column(String(20))
    analysis: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CapitalSettings(Base):
    __tablename__ = "capital_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(20, 2))
    currency: Mapped[str] = mapped_column(String(10), default="USDT")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class TrackedDecision(Base):
    __tablename__ = "tracked_decisions"

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    timeframe: Mapped[str] = mapped_column(String(10))
    direction: Mapped[str] = mapped_column(String(10))
    confidence: Mapped[int] = mapped_column(Integer)
    score: Mapped[int] = mapped_column(Integer)
    analysis_snapshot: Mapped[dict] = mapped_column(JSON)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(20, 2))
    allocated_amount: Mapped[Decimal] = mapped_column(Numeric(20, 2))
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TrackedPosition(Base):
    __tablename__ = "tracked_positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    decision_id: Mapped[int] = mapped_column(ForeignKey("tracked_decisions.id"), unique=True, index=True)
    wallet_address: Mapped[str | None] = mapped_column(String(42), index=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    direction: Mapped[str] = mapped_column(String(10))
    planned_entry: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    planned_size: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    leverage: Mapped[int] = mapped_column(Integer)
    margin_amount: Mapped[Decimal] = mapped_column(Numeric(20, 2))
    position_value: Mapped[Decimal] = mapped_column(Numeric(20, 2))
    stop_loss: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    take_profit: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CompletedTrade(Base):
    __tablename__ = "completed_trades"

    id: Mapped[int] = mapped_column(primary_key=True)
    decision_id: Mapped[int] = mapped_column(ForeignKey("tracked_decisions.id"), unique=True, index=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("tracked_positions.id"), unique=True, index=True)
    wallet_address: Mapped[str] = mapped_column(String(42), index=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    direction: Mapped[str] = mapped_column(String(10))
    entry_price: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    exit_price: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    size: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    fee: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    gross_pnl: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    net_pnl: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    pnl_percent: Mapped[float] = mapped_column(Float)
    entry_source: Mapped[str] = mapped_column(String(20))
    exit_source: Mapped[str] = mapped_column(String(20))
    exchange_fills: Mapped[list] = mapped_column(JSON, default=list)
    closed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ReviewRecord(Base):
    __tablename__ = "review_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    trade_id: Mapped[int | None] = mapped_column(ForeignKey("completed_trades.id"), index=True)
    review_type: Mapped[str] = mapped_column(String(20), index=True)
    review_date: Mapped[date] = mapped_column(Date, index=True)
    result: Mapped[str] = mapped_column(String(20))
    summary: Mapped[str] = mapped_column(Text)
    findings: Mapped[list] = mapped_column(JSON, default=list)
    adjustments: Mapped[list] = mapped_column(JSON, default=list)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WalletSettings(Base):
    __tablename__ = "wallet_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    address: Mapped[str] = mapped_column(String(42))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class SimulationWalletState(Base):
    __tablename__ = "simulation_wallets"

    # 存储键包含平台后缀，兼容已经存在的单主键 SQLite 表。
    client_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    balance: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    active_trade: Mapped[dict | None] = mapped_column(JSON)
    history: Mapped[list] = mapped_column(JSON, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class PlatformCredential(Base):
    __tablename__ = "platform_credentials"

    id: Mapped[int] = mapped_column(primary_key=True)
    platform: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    encrypted_api_key: Mapped[str] = mapped_column(Text)
    encrypted_secret_key: Mapped[str] = mapped_column(Text)
    encrypted_passphrase: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class MarketScanRecord(Base):
    __tablename__ = "market_scan_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    timeframe: Mapped[str] = mapped_column(String(10), index=True)
    scanned_markets: Mapped[int] = mapped_column(Integer)
    eligible_markets: Mapped[int] = mapped_column(Integer)
    opportunities: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class PositionMonitorRecord(Base):
    __tablename__ = "position_monitor_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("tracked_positions.id"), unique=True, index=True)
    action: Mapped[str] = mapped_column(String(20))
    current_price: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    unrealized_pnl: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    reason: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
