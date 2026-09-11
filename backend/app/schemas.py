from typing import Literal

from pydantic import BaseModel, Field


class MarketSnapshot(BaseModel):
    symbol: str
    price: float
    change_24h: float
    volume: float
    volatility: float
    funding_rate: float
    open_interest: float
    source: Literal["live", "demo"] = "demo"


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


class AnalysisRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9]+$")
    timeframe: Literal["1m", "5m", "15m", "1h", "4h", "1d"] = "4h"


class ScoreBreakdown(BaseModel):
    trend: int = Field(ge=0, le=30)
    structure: int = Field(ge=0, le=25)
    capital: int = Field(ge=0, le=20)
    macro: int = Field(ge=0, le=15)
    news: int = Field(ge=0, le=10)


class PositionSizing(BaseModel):
    risk_budget_rate: float = Field(ge=0, le=1)
    risk_budget_amount: float = Field(ge=0)
    stop_distance_rate: float = Field(ge=0, le=1)
    margin_amount: float = Field(ge=0)
    position_value: float = Field(ge=0)
    max_loss_amount: float = Field(ge=0)
    margin_cap_rate: float = Field(ge=0, le=1)
    capped: bool


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
    reasons: list[str]
    disclaimer: str
    source: Literal["live", "demo"] = "demo"


class OpportunityScanResponse(BaseModel):
    scanned_markets: int
    eligible_markets: int
    updated_at: str
    opportunities: list[AnalysisResponse]


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
    source: Literal["live", "demo"] = "demo"


class ReviewReport(BaseModel):
    period: str
    total: int
    correct: int
    incorrect: int
    win_rate: float
    findings: list[str]
    adjustments: list[str]
