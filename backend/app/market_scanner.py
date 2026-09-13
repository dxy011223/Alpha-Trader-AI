import asyncio
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete

from app.capital_settings import read_capital_settings
from app.database import SessionLocal
from app.models import MarketScanRecord
from app.config import get_settings
from app.scan_cache import acquire_scan_lock, read_scan_cache, release_scan_lock, write_timeframe_scan_cache
from app.schemas import AnalysisRequest, OpportunityScanResponse
from app.services import MarketPlatform, analyze_market, calculate_technical_indicators, get_candles, get_live_markets


_scan_locks: dict[tuple[str, str], asyncio.Lock] = {}


class MarketScanBusy(RuntimeError):
    pass


async def compute_market_scan(
    timeframe: str = "4h",
    limit: int = 8,
    platform: MarketPlatform = "hyperliquid",
) -> OpportunityScanResponse:
    markets = await get_live_markets(platform)
    total_amount = read_capital_settings().total_amount
    eligible_markets = [
        market
        for market in markets
        if market.volume >= 500_000
        and (platform != "hyperliquid" or market.open_interest >= 250_000)
    ]
    # 先按流动性和 24 小时动量筛出有限候选，再请求 K 线，避免全市场扇出。
    indicator_candidates = sorted(
        eligible_markets,
        key=lambda item: (item.volume, abs(item.change_24h)),
        reverse=True,
    )[: max(limit * 2, 12)]
    candle_sets = await asyncio.gather(*(
        get_candles(market.symbol, timeframe, 220, platform)
        for market in indicator_candidates
    ))
    decisions = sorted(
        (
            analyze_market(
                AnalysisRequest(symbol=market.symbol, timeframe=timeframe, platform=platform),
                market.model_copy(update={"volatility": indicators.atr_percent})
                if indicators.atr_percent is not None else market,
                total_amount,
                indicators,
            )
            for market, candles in zip(indicator_candidates, candle_sets, strict=True)
            for indicators in [calculate_technical_indicators(candles)]
        ),
        key=lambda item: item.score,
        reverse=True,
    )
    return OpportunityScanResponse(
        scanned_markets=len(markets),
        eligible_markets=len(eligible_markets),
        updated_at=datetime.now(UTC).isoformat(),
        opportunities=decisions[:limit],
        scan_source="live_scan",
        platform=platform,
    )


async def get_cached_or_compute_market_scan(
    timeframe: str,
    limit: int,
    platform: MarketPlatform,
) -> OpportunityScanResponse:
    """合并相同扫描的并发缓存未命中，并把成功结果写回缓存。"""
    cached = await asyncio.to_thread(read_scan_cache, timeframe, limit, platform)
    if cached is not None and all(item.analysis_engine == "rules" for item in cached.opportunities):
        return cached
    key = (platform, timeframe)
    lock = _scan_locks.setdefault(key, asyncio.Lock())
    async with lock:
        cached = await asyncio.to_thread(read_scan_cache, timeframe, limit, platform)
        if cached is not None and all(item.analysis_engine == "rules" for item in cached.opportunities):
            return cached
        lease = await asyncio.to_thread(acquire_scan_lock, timeframe, platform)
        if lease == "":
            for _ in range(20):
                await asyncio.sleep(0.25)
                cached = await asyncio.to_thread(read_scan_cache, timeframe, limit, platform)
                if cached is not None and all(item.analysis_engine == "rules" for item in cached.opportunities):
                    return cached
            raise MarketScanBusy("相同市场扫描正在其他实例中运行，请稍后重试")
        if lease is None and get_settings().environment.lower() == "production":
            raise MarketScanBusy("市场扫描协调服务暂时不可用")
        try:
            scan = await compute_market_scan(timeframe, limit, platform)
            await asyncio.to_thread(write_timeframe_scan_cache, timeframe, scan)
            return scan
        finally:
            if lease:
                await asyncio.to_thread(release_scan_lock, timeframe, platform, lease)


async def run_scheduled_market_scan(
    timeframe: str = "4h",
    limit: int = 8,
    platform: MarketPlatform = "hyperliquid",
) -> OpportunityScanResponse:
    scan = await compute_market_scan(timeframe, limit, platform)
    with SessionLocal.begin() as session:
        session.execute(
            delete(MarketScanRecord).where(
                MarketScanRecord.created_at < datetime.now(UTC) - timedelta(days=7)
            )
        )
        session.add(
            MarketScanRecord(
                timeframe=timeframe,
                scanned_markets=scan.scanned_markets,
                eligible_markets=scan.eligible_markets,
                opportunities=[item.model_dump(mode="json") for item in scan.opportunities],
            )
        )
    write_timeframe_scan_cache(timeframe, scan)
    return scan
