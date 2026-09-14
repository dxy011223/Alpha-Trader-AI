from datetime import date, datetime
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, SecretStr


class MarketSnapshot(BaseModel):
    symbol: str
    price: float
    change_24h: float
    volume: float
    volatility: float
    funding_rate: float
    open_interest: float
    long_short_ratio: float | None = None
    source: Literal["live", "demo"] = "demo"
    platform: Literal["hyperliquid", "binance", "okx"] = "hyperliquid"


class Candle(BaseModel):
    open_time: int
    close_time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class NewsItem(BaseModel):
    id: int
    title: str
    source: str
    published_at: str
    impact: int = Field(ge=1, le=5)
    assets: list[str]
    direction: Literal["bullish", "bearish", "neutral"]
    analysis: str


class NewsArchiveResponse(BaseModel):
    date: str
    total: int
    items: list[NewsItem]
    platform: Literal["hyperliquid", "binance", "okx"] = "hyperliquid"


class AnalysisRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9]+$")
    timeframe: Literal["1m", "5m", "15m", "1h", "4h", "1d"] = "4h"
    platform: Literal["hyperliquid", "binance", "okx"] = "hyperliquid"


class ScoreBreakdown(BaseModel):
    # 策略优化后单项权重会变化；五项合计仍由服务层约束为不超过 100。
    trend: int = Field(ge=0, le=40)
    structure: int = Field(ge=0, le=40)
    capital: int = Field(ge=0, le=40)
    macro: int = Field(ge=0, le=40)
    news: int = Field(ge=0, le=40)


class PositionSizing(BaseModel):
    risk_budget_rate: float = Field(ge=0, le=1)
    risk_budget_amount: float = Field(ge=0)
    stop_distance_rate: float = Field(ge=0, le=1)
    margin_amount: float = Field(ge=0)
    position_value: float = Field(ge=0)
    max_loss_amount: float = Field(ge=0)
    margin_cap_rate: float = Field(ge=0, le=1)
    capped: bool


class TechnicalIndicators(BaseModel):
    ema20: float | None = None
    ema50: float | None = None
    ema200: float | None = None
    ema20_slope_percent: float | None = None
    ema50_slope_percent: float | None = None
    rsi14: float | None = None
    macd: float | None = None
    macd_signal: float | None = None
    macd_histogram: float | None = None
    atr14: float | None = None
    atr_percent: float | None = None
    realized_volatility: float | None = None
    volume_ratio: float | None = None


class DecisionRevisionSnapshot(BaseModel):
    revision: int = Field(ge=1, le=3)
    reference_price: float | None = None
    entry_range: list[float]
    stop_loss: float
    take_profit: list[float]
    leverage: int
    risk: Literal["low", "medium", "high"]
    score: int = Field(ge=0, le=100)
    confidence: int = Field(ge=0, le=100)
    generated_at: str | None = None
    archived_at: str
    archive_reason: str
    revision_reason: str | None = None


class HistoryDirectionPerformance(BaseModel):
    sample_count: int = Field(default=0, ge=0, le=1500)
    wins: int = Field(default=0, ge=0, le=1500)
    win_rate: float = Field(default=0, ge=0, le=100)
    threshold_adjustment: int = Field(default=0, ge=-1, le=2)
    risk_multiplier: float = Field(default=1, ge=0.5, le=1.05)


class DecisionHistoryPolicy(BaseModel):
    timeframe: Literal["1m", "5m", "15m", "1h", "4h", "1d"] | None = None
    sample_count: int = Field(default=0, ge=0, le=1500)
    wins: int = Field(default=0, ge=0, le=1500)
    losses: int = Field(default=0, ge=0, le=1500)
    win_rate: float = Field(default=0, ge=0, le=100)
    average_r: float = Field(default=0, ge=-2, le=2)
    recent_win_rate: float = Field(default=0, ge=0, le=100)
    consecutive_losses: int = Field(default=0, ge=0, le=200)
    threshold_adjustment: int = Field(default=0, ge=-2, le=4)
    risk_multiplier: float = Field(default=1, ge=0.5, le=1.05)
    direction_performance: dict[str, HistoryDirectionPerformance] = Field(default_factory=dict)
    fingerprint: str = Field(default="baseline", min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    scope_key: str = Field(default="baseline", min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    applied_threshold: int | None = Field(default=None, ge=68, le=78)
    applied_risk_multiplier: float = Field(default=1, ge=0.5, le=1.05)


class AnalysisResponse(BaseModel):
    symbol: str
    instrument: str
    direction: Literal["LONG", "SHORT", "WAIT"]
    confidence: int = Field(ge=0, le=100)
    score: int = Field(ge=0, le=100)
    score_breakdown: ScoreBreakdown
    entry_range: list[float]
    stop_loss: float
    take_profit: list[float]
    leverage: int
    risk: Literal["low", "medium", "high"]
    position_sizing: PositionSizing
    indicators: TechnicalIndicators | None = None
    reasons: list[str]
    disclaimer: str
    source: Literal["live", "demo"] = "demo"
    platform: Literal["hyperliquid", "binance", "okx"] = "hyperliquid"
    funding_rate: float | None = None
    analysis_engine: Literal["openai", "rules"] = "rules"
    analysis_model: str | None = None
    decision_schema_version: Literal["ai_full_v1"] | None = None
    strategy_version: str = "v1"
    strategy_parameters: dict = Field(default_factory=dict)
    history_policy: DecisionHistoryPolicy | None = None
    reference_price: float | None = None
    current_price: float | None = None
    generated_at: str | None = None
    plan_id: str = Field(default_factory=lambda: uuid4().hex)
    decision_revision: int = Field(default=1, ge=1, le=3)
    revision_reason: str | None = None
    revision_history: list[DecisionRevisionSnapshot] = Field(default_factory=list)
    soft_failure_count: int = Field(default=0, ge=0, le=2)
    missed_entry_count: int = Field(default=0, ge=0, le=2)
    decision_status: Literal[
        "watching", "confirming", "missed_entry", "executable", "invalidated", "target_reached"
    ] = "watching"
    is_executable: bool = False
    status_reason: str = "等待进入计划入场区间"


class OpportunityScanResponse(BaseModel):
    scanned_markets: int
    eligible_markets: int
    updated_at: str
    opportunities: list[AnalysisResponse]
    scan_source: Literal["live_scan", "scheduled_cache"] = "live_scan"
    platform: Literal["hyperliquid", "binance", "okx"] = "hyperliquid"
    total_amount: float | None = None
    data_unavailable_markets: int = Field(default=0, ge=0)


class CapitalSettingsUpdate(BaseModel):
    total_amount: float = Field(gt=0, le=1_000_000_000)
    currency: Literal["USDT"] = "USDT"


class CapitalSettingsResponse(CapitalSettingsUpdate):
    updated_at: str


class WalletSnapshot(BaseModel):
    address: str
    equity: float
    available_balance: float
    unrealized_pnl: float
    positions: list[dict]
    history: list[dict]
    source: Literal["live", "unavailable"] = "unavailable"
    error: str | None = None
    platform: Literal["hyperliquid", "binance", "okx"] = "hyperliquid"


class WalletSettingsUpdate(BaseModel):
    address: str = Field(pattern=r"^0x[a-fA-F0-9]{40}$")


class WalletSettingsResponse(WalletSettingsUpdate):
    updated_at: str


class PlatformCredentialUpdate(BaseModel):
    api_key: SecretStr = Field(min_length=4, max_length=256)
    secret_key: SecretStr = Field(min_length=8, max_length=256)
    passphrase: SecretStr | None = Field(default=None, min_length=1, max_length=256)


class PlatformCredentialResponse(BaseModel):
    platform: Literal["binance", "okx"]
    configured: bool
    api_key_hint: str | None = None
    updated_at: datetime | None = None


class ExecutionCreate(BaseModel):
    analysis: AnalysisResponse
    timeframe: Literal["1m", "5m", "15m", "1h", "4h", "1d"]
    total_amount: float = Field(gt=0, le=1_000_000_000)


class DecisionRecordResponse(BaseModel):
    id: int
    status: Literal["active", "completed", "cancelled"]
    analysis: AnalysisResponse
    timeframe: str
    total_amount: float
    allocated_amount: float
    started_at: datetime
    completed_at: datetime | None = None


class PositionRecordResponse(BaseModel):
    id: int
    decision_id: int
    wallet_address: str | None
    symbol: str
    direction: Literal["LONG", "SHORT"]
    planned_entry: float
    planned_size: float
    leverage: int
    margin_amount: float
    position_value: float
    stop_loss: float
    take_profit: list[float]
    status: Literal["open", "completed", "cancelled"]
    created_at: datetime
    closed_at: datetime | None = None


class ExecutionStateResponse(BaseModel):
    decision: DecisionRecordResponse
    position: PositionRecordResponse


class PositionMonitorResponse(BaseModel):
    position_id: int
    decision_id: int
    symbol: str
    platform: Literal["hyperliquid", "binance", "okx"]
    action: Literal["HOLD", "REDUCE", "EXIT", "ADJUST_SL", "ADJUST_TP"]
    opening_score: int = Field(ge=0, le=100)
    current_score: int = Field(ge=0, le=100)
    current_price: float
    unrealized_pnl: float
    reason: str
    updated_at: datetime


class CompletedTradeResponse(BaseModel):
    id: int
    decision_id: int
    position_id: int
    wallet_address: str
    symbol: str
    direction: Literal["LONG", "SHORT"]
    entry_price: float
    exit_price: float
    size: float
    fee: float
    gross_pnl: float
    net_pnl: float
    pnl_percent: float
    entry_source: Literal["hyperliquid", "binance", "okx", "plan"]
    exit_source: Literal["hyperliquid", "binance", "okx"]
    closed_at: datetime
    analysis: AnalysisResponse
    timeframe: str
    started_at: datetime
    allocated_amount: float
    platform: Literal["hyperliquid", "binance", "okx"] = "hyperliquid"


class ReviewRecordResponse(BaseModel):
    id: int
    trade_id: int | None
    review_type: Literal["trade", "daily"]
    review_date: date
    result: Literal["win", "loss", "breakeven", "no_trades"]
    summary: str
    findings: list[str]
    adjustments: list[str]
    metrics: dict
    created_at: datetime


class StrategyVersionResponse(BaseModel):
    version: str
    parameters: dict
    performance: dict
    created_at: datetime


class CompletionResponse(BaseModel):
    trade: CompletedTradeResponse
    review: ReviewRecordResponse


class SimulatedActiveTradePayload(BaseModel):
    id: int
    analysis: AnalysisResponse
    timeframe: Literal["1m", "5m", "15m", "1h", "4h", "1d"]
    entryPrice: float = Field(gt=0)
    size: float = Field(gt=0)
    allocatedAmount: float = Field(gt=0)
    latestPrice: float = Field(gt=0)
    unrealizedPnl: float
    startedAt: int = Field(gt=0)


class SimulatedCompletedTradePayload(CompletedTradeResponse):
    is_simulated: Literal[True] = True
    exit_reason: Literal["take_profit", "stop_loss"]


class SimulationWalletUpdate(BaseModel):
    enabled: bool = False
    # 模拟净值仅用于累计盈亏，允许因历史亏损变为负数。
    balance: float = Field(default=1_000, ge=-1_000_000_000, le=1_000_000_000)
    activeTrades: list[SimulatedActiveTradePayload] | None = Field(default=None, max_length=3)
    activeTrade: SimulatedActiveTradePayload | None = None
    history: list[SimulatedCompletedTradePayload] = Field(default_factory=list, max_length=500)


class SimulationWalletResponse(SimulationWalletUpdate):
    activeTrades: list[SimulatedActiveTradePayload] = Field(default_factory=list, max_length=3)
    client_id: str
    platform: Literal["hyperliquid", "binance", "okx"]
    updated_at: datetime
