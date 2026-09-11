from datetime import UTC, date, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from app.capital_settings import read_capital_settings, write_capital_settings
from app.news_archive import get_news_archive
from app.schemas import AnalysisRequest, AnalysisResponse, Candle, CapitalSettingsResponse, CapitalSettingsUpdate, MarketSnapshot, NewsArchiveResponse, NewsItem, OpportunityScanResponse, ReviewReport, WalletSnapshot
from app.services import analyze_market, create_review, get_candles, get_live_market, get_live_markets, get_live_wallet

router = APIRouter(prefix="/api/v1")


@router.get("/market/{symbol}", response_model=MarketSnapshot, summary="获取实时市场快照")
async def market_snapshot(symbol: str) -> MarketSnapshot:
    market = await get_live_market(symbol)
    if market is None:
        raise HTTPException(status_code=404, detail="暂不支持该交易品种")
    return market


@router.get("/market/{symbol}/candles", response_model=list[Candle], summary="获取 K 线数据")
async def market_candles(symbol: str, interval: str = "1h", limit: int = 120) -> list[Candle]:
    if interval not in {"1m", "5m", "15m", "1h", "4h", "1d"}:
        raise HTTPException(status_code=422, detail="不支持的 K 线周期")
    return await get_candles(symbol, interval, min(max(limit, 1), 500))


@router.get("/news/latest", response_model=list[NewsItem], summary="获取最新新闻分析")
def latest_news() -> list[NewsItem]:
    return get_news_archive(date.today()).items


@router.get("/news", response_model=NewsArchiveResponse, summary="按日期获取全部新闻归档")
def news_archive(target_date: date | None = Query(default=None, alias="date")) -> NewsArchiveResponse:
    return get_news_archive(target_date or date.today())


@router.get("/settings/capital", response_model=CapitalSettingsResponse, summary="读取总资金设置")
def capital_settings() -> CapitalSettingsResponse:
    return read_capital_settings()


@router.put("/settings/capital", response_model=CapitalSettingsResponse, summary="保存总资金设置")
def update_capital_settings(payload: CapitalSettingsUpdate) -> CapitalSettingsResponse:
    return write_capital_settings(payload)


@router.post("/ai/analyze", response_model=AnalysisResponse, summary="生成 AI 交易计划")
async def ai_analyze(payload: AnalysisRequest) -> AnalysisResponse:
    # MVP 使用可解释评分器；后续可在此替换为真实模型调用。
    market = await get_live_market(payload.symbol)
    total_amount = read_capital_settings().total_amount
    return analyze_market(payload, market, total_amount)


@router.get("/ai/opportunities", response_model=OpportunityScanResponse, summary="扫描全市场交易机会")
async def ai_opportunities(
    timeframe: Literal["1m", "5m", "15m", "1h", "4h", "1d"] = "4h",
    limit: int = Query(default=8, ge=4, le=20),
) -> OpportunityScanResponse:
    markets = await get_live_markets()
    total_amount = read_capital_settings().total_amount
    # 先扫描全部有效市场，再用成交额与持仓量剔除难以执行的低流动性机会。
    eligible_markets = [
        market for market in markets
        if market.volume >= 500_000 and market.open_interest >= 250_000
    ]
    decisions = sorted(
        (
            analyze_market(AnalysisRequest(symbol=market.symbol, timeframe=timeframe), market, total_amount)
            for market in eligible_markets
        ),
        key=lambda item: item.score,
        reverse=True,
    )
    return OpportunityScanResponse(
        scanned_markets=len(markets),
        eligible_markets=len(eligible_markets),
        updated_at=datetime.now(UTC).isoformat(),
        opportunities=decisions[:limit],
    )


@router.get("/wallet/{address}", response_model=WalletSnapshot, summary="读取 Hyperliquid 钱包")
async def wallet_snapshot(address: str) -> WalletSnapshot:
    if len(address) != 42 or not address.startswith("0x"):
        raise HTTPException(status_code=422, detail="钱包地址格式不正确")
    return await get_live_wallet(address)


@router.post("/review/daily", response_model=ReviewReport, summary="生成每日 AI 决策复盘")
def daily_review() -> ReviewReport:
    return create_review()
