import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete

from app.capital_settings import read_capital_settings
from app.database import SessionLocal
from app.models import MarketScanRecord
from app.config import get_settings
from app.scan_cache import acquire_scan_lock, read_decision_plan_cache, read_scan_cache, release_scan_lock, write_decision_plan_cache, write_timeframe_scan_cache
from app.schemas import AnalysisRequest, DecisionHistoryPolicy, OpportunityScanResponse
from app.services import MarketPlatform, analyze_market, calculate_technical_indicators, get_candles, get_live_markets, refresh_decision_plan


_scan_locks: dict[tuple[str, str, str], asyncio.Lock] = {}
CANDLE_FETCH_CONCURRENCY = 2
logger = logging.getLogger(__name__)


def _has_complete_trend_data(decision) -> bool:
    indicators = decision.indicators
    return decision.source == "live" and indicators is not None and all(
        value is not None for value in (indicators.ema20, indicators.ema50, indicators.ema200)
    )


class MarketScanBusy(RuntimeError):
    pass


async def compute_market_scan(
    timeframe: str = "4h",
    limit: int = 8,
    platform: MarketPlatform = "hyperliquid",
    total_amount: float | None = None,
    history_policy: DecisionHistoryPolicy | None = None,
) -> OpportunityScanResponse:
    markets = await get_live_markets(platform)
    total_amount = total_amount or read_capital_settings().total_amount
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
    candle_semaphore = asyncio.Semaphore(CANDLE_FETCH_CONCURRENCY)

    async def load_candidate_candles(symbol: str):
        async with candle_semaphore:
            return await get_candles(symbol, timeframe, 220, platform)

    candle_sets = await asyncio.gather(*(
        load_candidate_candles(market.symbol) for market in indicator_candidates
    ))
    analyzed_decisions = [
            analyze_market(
                AnalysisRequest(symbol=market.symbol, timeframe=timeframe, platform=platform),
                market.model_copy(update={"volatility": indicators.atr_percent})
                if indicators.atr_percent is not None else market,
                total_amount,
                indicators,
                history_policy=history_policy,
            )
            for market, candles in zip(indicator_candidates, candle_sets, strict=True)
            for indicators in [calculate_technical_indicators(candles)]
    ]
    data_unavailable_markets = sum(
        not _has_complete_trend_data(item) for item in analyzed_decisions
    )
    refreshed_decisions = sorted(
        (item for item in analyzed_decisions if _has_complete_trend_data(item)),
        key=lambda item: item.score,
        reverse=True,
    )
    history_key = history_policy.fingerprint if history_policy else "baseline"
    history_scope_key = history_policy.scope_key if history_policy else "baseline"
    previous_scan = await asyncio.to_thread(
        read_decision_plan_cache, timeframe, platform, history_scope_key
    )
    previous_by_symbol = {
        item.symbol: item for item in previous_scan.opportunities
    } if previous_scan else {}
    if not refreshed_decisions:
        previous_opportunities = [
            item.model_copy(update={
                "decision_status": "confirming",
                "is_executable": False,
                "status_reason": "最新 K 线暂不可用，保留上次有效计划但暂停执行",
                "reasons": [
                    "最新 K 线暂不可用，保留上次有效计划但暂停执行",
                    *item.reasons,
                ],
            })
            for item in (previous_scan.opportunities if previous_scan else [])
            if _has_complete_trend_data(item)
        ][:limit]
        return OpportunityScanResponse(
            scanned_markets=len(markets),
            eligible_markets=len(eligible_markets),
            updated_at=previous_scan.updated_at if previous_opportunities else datetime.now(UTC).isoformat(),
            opportunities=previous_opportunities,
            scan_source="scheduled_cache" if previous_opportunities else "live_scan",
            platform=platform,
            total_amount=total_amount,
            data_unavailable_markets=data_unavailable_markets,
        )
    market_by_symbol = {market.symbol: market for market in indicator_candidates}
    candles_by_symbol = {
        market.symbol: candles
        for market, candles in zip(indicator_candidates, candle_sets, strict=True)
    }
    decisions = [
        refresh_decision_plan(
            previous_by_symbol[item.symbol],
            item,
            market_by_symbol[item.symbol].price,
            timeframe,
            total_amount,
            candles=candles_by_symbol[item.symbol],
        ) if item.symbol in previous_by_symbol else item
        for item in refreshed_decisions
    ]
    # 机会质量以评分为主；同分时优先展示可执行、其次展示观察中的决策。
    decisions.sort(
        key=lambda item: (item.score, item.is_executable, item.decision_status == "watching"),
        reverse=True,
    )
    scan = OpportunityScanResponse(
        scanned_markets=len(markets),
        eligible_markets=len(eligible_markets),
        updated_at=datetime.now(UTC).isoformat(),
        opportunities=decisions[:limit],
        scan_source="live_scan",
        platform=platform,
        total_amount=total_amount,
        data_unavailable_markets=data_unavailable_markets,
    )
    await asyncio.to_thread(
        write_decision_plan_cache, timeframe, scan, history_scope_key
    )
    return scan


async def get_cached_or_compute_market_scan(
    timeframe: str,
    limit: int,
    platform: MarketPlatform,
    total_amount: float | None = None,
    force_refresh: bool = False,
    history_policy: DecisionHistoryPolicy | None = None,
) -> OpportunityScanResponse:
    """合并相同扫描的并发缓存未命中，并把成功结果写回缓存。"""
    total_amount = total_amount or read_capital_settings().total_amount
    history_key = history_policy.fingerprint if history_policy else "baseline"
    if not force_refresh:
        cached = await asyncio.to_thread(
            read_scan_cache, timeframe, limit, platform, total_amount, history_key
        )
        if (
            cached is not None
            and bool(cached.opportunities)
            and all(_has_complete_trend_data(item) for item in cached.opportunities)
            and all(item.analysis_engine == "rules" for item in cached.opportunities)
        ):
            return cached
    key = (platform, timeframe, history_key)
    lock = _scan_locks.setdefault(key, asyncio.Lock())
    async with lock:
        if not force_refresh:
            cached = await asyncio.to_thread(
                read_scan_cache, timeframe, limit, platform, total_amount, history_key
            )
            if (
                cached is not None
                and bool(cached.opportunities)
                and all(_has_complete_trend_data(item) for item in cached.opportunities)
                and all(item.analysis_engine == "rules" for item in cached.opportunities)
            ):
                return cached
        lease = await asyncio.to_thread(
            acquire_scan_lock, timeframe, platform, total_amount, history_key
        )
        if lease == "":
            if force_refresh:
                raise MarketScanBusy("市场扫描正在刷新，请稍后重试")
            for _ in range(20):
                await asyncio.sleep(0.25)
                cached = await asyncio.to_thread(
                    read_scan_cache, timeframe, limit, platform, total_amount, history_key
                )
                if (
                    cached is not None
                    and bool(cached.opportunities)
                    and all(_has_complete_trend_data(item) for item in cached.opportunities)
                    and all(item.analysis_engine == "rules" for item in cached.opportunities)
                ):
                    return cached
            raise MarketScanBusy("相同市场扫描正在其他实例中运行，请稍后重试")
        if lease is None and get_settings().environment.lower() == "production":
            raise MarketScanBusy("市场扫描协调服务暂时不可用")
        try:
            scan = await compute_market_scan(
                timeframe, limit, platform, total_amount, history_policy
            )
            if scan.scan_source == "live_scan" and scan.opportunities:
                await asyncio.to_thread(
                    write_timeframe_scan_cache, timeframe, scan, history_key
                )
            return scan
        finally:
            if lease:
                await asyncio.to_thread(
                    release_scan_lock,
                    timeframe,
                    platform,
                    lease,
                    total_amount,
                    history_key,
                )


async def run_scheduled_market_scan(
    timeframe: str = "4h",
    limit: int = 8,
    platform: MarketPlatform = "hyperliquid",
) -> OpportunityScanResponse:
    scan = await compute_market_scan(timeframe, limit, platform)
    if not scan.opportunities or scan.scan_source != "live_scan":
        logger.warning(
            "定时市场扫描未获得完整 K 线决策，本轮不覆盖历史扫描记录"
        )
        return scan
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
