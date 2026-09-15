import asyncio
import json
import logging
import math
import statistics
import time
from datetime import UTC, datetime
from typing import Literal

import httpx

from app.news_sources import fetch_live_news
from app.schemas import AnalysisRequest, AnalysisResponse, Candle, DecisionHistoryPolicy, DecisionRevisionSnapshot, MarketSnapshot, NewsItem, PositionSizing, TechnicalIndicators, WalletSnapshot
from app.strategy_scoring import apply_strategy_weights, normalize_strategy_parameters

logger = logging.getLogger(__name__)
HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info"
BINANCE_FUTURES_URL = "https://fapi.binance.com"
OKX_API_URL = "https://www.okx.com"
MarketPlatform = Literal["hyperliquid", "binance", "okx"]

DECISION_VALIDITY_SECONDS = {
    "1m": 300,
    "5m": 900,
    "15m": 1_800,
    "1h": 3_600,
    "4h": 14_400,
    "1d": 86_400,
}
MIN_REMAINING_REWARD_RISK = 1.5
DECISION_SCORE_HYSTERESIS = 2
SOFT_FAILURE_CONFIRMATIONS = 2
MISSED_ENTRY_CONFIRMATIONS = 2
MAX_DECISION_REVISIONS = 3
MAX_MISSED_ENTRY_ATR = 0.5
MAX_TARGET_PROGRESS = 0.5
HISTORY_POLICY_MIN_SAMPLES = 12
HISTORY_DIRECTION_MIN_SAMPLES = 8
MIN_EMA_SPREAD_PERCENT = 0.1
MAX_EMA_SPREAD_ATR_FACTOR = 0.25
MAX_EMA_SPREAD_THRESHOLD = 0.5
MAX_ENTRY_STRETCH_ATR = 1.5
LONG_RSI_EXHAUSTION = 75
SHORT_RSI_EXHAUSTION = 25
EMA_SLOPE_LOOKBACK = 3
MIN_VOLUME_RATIO = 0.5
MAX_CROWDED_FUNDING_RATE = 0.05
CANDLE_REQUEST_MAX_ATTEMPTS = 3
CANDLE_RETRY_BASE_SECONDS = 0.4
CANDLE_RETRY_MAX_SECONDS = 3.0
CANDLE_RETRIABLE_STATUS_CODES = {429, 500, 502, 503, 504}
MIN_ATR_PRICE_RATE = 0.0025
MAX_ATR_PRICE_RATE = 0.03
ENTRY_ATR_NEAR = 0.25
ENTRY_ATR_FAR = 0.75
STOP_ATR_DISTANCE = 1.25
FIRST_TARGET_R = 2
SECOND_TARGET_R = 3


MARKETS = {
    "BTC": MarketSnapshot(symbol="BTC", price=82437.20, change_24h=2.84, volume=28_460_000_000, volatility=3.12, funding_rate=0.0102, open_interest=18_720_000_000),
    "ETH": MarketSnapshot(symbol="ETH", price=3548.76, change_24h=1.92, volume=14_820_000_000, volatility=3.86, funding_rate=0.0084, open_interest=9_640_000_000),
    "SOL": MarketSnapshot(symbol="SOL", price=179.42, change_24h=-0.74, volume=3_960_000_000, volatility=5.14, funding_rate=-0.0021, open_interest=2_180_000_000),
    "HYPE": MarketSnapshot(symbol="HYPE", price=39.28, change_24h=4.63, volume=642_000_000, volatility=6.42, funding_rate=0.0148, open_interest=782_000_000),
}


def parse_history_policy(
    value: str | None,
    platform: MarketPlatform,
) -> DecisionHistoryPolicy | None:
    """解析 Worker 生成的匿名历史聚合；异常数据直接回退到基础规则。"""
    if not value:
        return None
    try:
        payload = json.loads(value)
        raw = payload.get("platforms", {}).get(platform)
        policy = DecisionHistoryPolicy.model_validate(raw)
    except (AttributeError, TypeError, ValueError):
        return None
    if policy.wins + policy.losses > policy.sample_count:
        return None
    for direction in ("LONG", "SHORT"):
        performance = policy.direction_performance.get(direction)
        if performance and performance.wins > performance.sample_count:
            return None
    return policy


def apply_history_policy(
    base_threshold: int,
    direction: Literal["LONG", "SHORT", "WAIT"],
    policy: DecisionHistoryPolicy | None,
) -> tuple[int, float, DecisionHistoryPolicy | None]:
    """历史只调整准入门槛与风险预算，不改写五维评分或技术方向。"""
    if policy is None or policy.sample_count < HISTORY_POLICY_MIN_SAMPLES:
        return base_threshold, 1, None
    threshold_adjustment = policy.threshold_adjustment
    risk_multiplier = policy.risk_multiplier
    performance = policy.direction_performance.get(direction)
    if performance and performance.sample_count >= HISTORY_DIRECTION_MIN_SAMPLES:
        threshold_adjustment += performance.threshold_adjustment
        risk_multiplier *= performance.risk_multiplier
    effective_threshold = max(68, min(78, base_threshold + threshold_adjustment))
    applied_risk_multiplier = max(0.5, min(1.05, risk_multiplier))
    return effective_threshold, applied_risk_multiplier, policy.model_copy(update={
        "applied_threshold": effective_threshold,
        "applied_risk_multiplier": round(applied_risk_multiplier, 4),
    })


def get_market(symbol: str) -> MarketSnapshot | None:
    return MARKETS.get(symbol.upper())


async def _get_hyperliquid_markets() -> list[MarketSnapshot]:
    """单次读取全部永续合约市场，过滤已下架及无有效价格的品种。"""
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            response = await client.post(HYPERLIQUID_INFO_URL, json={"type": "metaAndAssetCtxs"})
            response.raise_for_status()
        metadata, contexts = response.json()
        markets: list[MarketSnapshot] = []
        for item, context in zip(metadata["universe"], contexts, strict=True):
            if item.get("isDelisted"):
                continue
            try:
                price = float(context["markPx"])
                if price <= 0:
                    continue
                previous = float(context.get("prevDayPx") or price)
                change = ((price - previous) / previous * 100) if previous else 0
                markets.append(MarketSnapshot(
                    symbol=str(item["name"]).upper(),
                    price=price,
                    change_24h=round(change, 4),
                    volume=float(context.get("dayNtlVlm") or 0),
                    volatility=round(abs(change), 4),
                    funding_rate=float(context.get("funding") or 0) * 100,
                    open_interest=float(context.get("openInterest") or 0) * price,
                    source="live",
                    platform="hyperliquid",
                ))
            except (KeyError, ValueError, TypeError):
                # 单个市场字段异常时继续扫描，不影响其余候选品种。
                continue
        return markets
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        logger.warning("全市场实时行情获取失败，已回退到演示数据：%s", exc)
        return list(MARKETS.values())


async def _get_binance_markets() -> list[MarketSnapshot]:
    async with httpx.AsyncClient(timeout=6.0) as client:
        ticker_response = await client.get(f"{BINANCE_FUTURES_URL}/fapi/v1/ticker/24hr")
        funding_response = await client.get(f"{BINANCE_FUTURES_URL}/fapi/v1/premiumIndex")
        ticker_response.raise_for_status()
        funding_response.raise_for_status()
    funding_by_symbol = {
        str(item.get("symbol")): float(item.get("lastFundingRate") or 0) * 100
        for item in funding_response.json()
    }
    markets = []
    for item in ticker_response.json():
        instrument = str(item.get("symbol") or "")
        if not instrument.endswith("USDT"):
            continue
        try:
            price = float(item["lastPrice"])
            if price <= 0:
                continue
            change = float(item.get("priceChangePercent") or 0)
            markets.append(MarketSnapshot(
                symbol=instrument.removesuffix("USDT"),
                price=price,
                change_24h=change,
                volume=float(item.get("quoteVolume") or 0),
                volatility=abs(change),
                funding_rate=funding_by_symbol.get(instrument, 0),
                open_interest=0,
                source="live",
                platform="binance",
            ))
        except (KeyError, ValueError, TypeError):
            continue
    return markets


async def _get_okx_markets() -> list[MarketSnapshot]:
    async with httpx.AsyncClient(timeout=6.0) as client:
        ticker_response = await client.get(
            f"{OKX_API_URL}/api/v5/market/tickers", params={"instType": "SWAP"}
        )
        interest_response = await client.get(
            f"{OKX_API_URL}/api/v5/public/open-interest", params={"instType": "SWAP"}
        )
        ticker_response.raise_for_status()
        interest_response.raise_for_status()
    interest_by_instrument = {
        str(item.get("instId")): float(item.get("oiCcy") or 0)
        for item in interest_response.json().get("data", [])
    }
    markets = []
    for item in ticker_response.json().get("data", []):
        instrument = str(item.get("instId") or "")
        if not instrument.endswith("-USDT-SWAP"):
            continue
        try:
            price = float(item["last"])
            if price <= 0:
                continue
            open_price = float(item.get("open24h") or price)
            change = (price - open_price) / open_price * 100 if open_price else 0
            markets.append(MarketSnapshot(
                symbol=instrument.removesuffix("-USDT-SWAP"),
                price=price,
                change_24h=round(change, 4),
                volume=float(item.get("volCcy24h") or 0) * price,
                volatility=round(abs(change), 4),
                funding_rate=0,
                open_interest=interest_by_instrument.get(instrument, 0) * price,
                source="live",
                platform="okx",
            ))
        except (KeyError, ValueError, TypeError):
            continue
    return markets


async def get_live_markets(platform: MarketPlatform = "hyperliquid") -> list[MarketSnapshot]:
    """读取指定平台的全部永续合约市场。"""
    try:
        if platform == "binance":
            return await _get_binance_markets()
        if platform == "okx":
            return await _get_okx_markets()
        return await _get_hyperliquid_markets()
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        logger.warning("%s 全市场行情获取失败，已回退到演示数据：%s", platform, exc)
        return [market.model_copy(update={"platform": platform}) for market in MARKETS.values()]


async def _get_binance_market(symbol: str) -> MarketSnapshot:
    instrument = f"{symbol.upper()}USDT"
    async with httpx.AsyncClient(timeout=4.0) as client:
        ticker_response = await client.get(f"{BINANCE_FUTURES_URL}/fapi/v1/ticker/24hr", params={"symbol": instrument})
        funding_response = await client.get(f"{BINANCE_FUTURES_URL}/fapi/v1/premiumIndex", params={"symbol": instrument})
        interest_response = await client.get(f"{BINANCE_FUTURES_URL}/fapi/v1/openInterest", params={"symbol": instrument})
        for response in (ticker_response, funding_response, interest_response):
            response.raise_for_status()
    ticker = ticker_response.json()
    funding = funding_response.json()
    interest = interest_response.json()
    price = float(ticker["lastPrice"])
    return MarketSnapshot(
        symbol=symbol.upper(),
        price=price,
        change_24h=float(ticker["priceChangePercent"]),
        volatility=abs(float(ticker["priceChangePercent"])),
        volume=float(ticker.get("quoteVolume") or 0),
        funding_rate=float(funding.get("lastFundingRate") or 0) * 100,
        open_interest=float(interest.get("openInterest") or 0) * price,
        source="live",
        platform="binance",
    )


async def _get_okx_market(symbol: str) -> MarketSnapshot:
    instrument = f"{symbol.upper()}-USDT-SWAP"
    async with httpx.AsyncClient(timeout=4.0) as client:
        ticker_response = await client.get(f"{OKX_API_URL}/api/v5/market/ticker", params={"instId": instrument})
        funding_response = await client.get(f"{OKX_API_URL}/api/v5/public/funding-rate", params={"instId": instrument})
        interest_response = await client.get(f"{OKX_API_URL}/api/v5/public/open-interest", params={"instId": instrument})
        for response in (ticker_response, funding_response, interest_response):
            response.raise_for_status()
    ticker = ticker_response.json()["data"][0]
    funding = funding_response.json()["data"][0]
    interest = interest_response.json()["data"][0]
    price = float(ticker["last"])
    open_price = float(ticker.get("open24h") or price)
    change = (price - open_price) / open_price * 100 if open_price else 0
    return MarketSnapshot(
        symbol=symbol.upper(),
        price=price,
        change_24h=round(change, 4),
        volatility=round(abs(change), 4),
        volume=float(ticker.get("volCcy24h") or 0) * price,
        funding_rate=float(funding.get("fundingRate") or 0) * 100,
        open_interest=float(interest.get("oiCcy") or 0) * price,
        source="live",
        platform="okx",
    )


async def get_live_market(symbol: str, platform: MarketPlatform = "hyperliquid") -> MarketSnapshot | None:
    """从全市场快照中读取指定品种，网络异常时保留核心币种演示数据。"""
    normalized_symbol = symbol.upper()
    try:
        if platform == "binance":
            return await _get_binance_market(normalized_symbol)
        if platform == "okx":
            return await _get_okx_market(normalized_symbol)
        markets = await get_live_markets("hyperliquid")
        return next((market for market in markets if market.symbol == normalized_symbol), get_market(normalized_symbol))
    except (httpx.HTTPError, KeyError, IndexError, ValueError, TypeError) as exc:
        logger.warning("%s 行情获取失败，已回退到演示数据：%s", platform, exc)
        fallback = get_market(normalized_symbol)
        return fallback.model_copy(update={"platform": platform}) if fallback else None


async def get_candles(
    symbol: str,
    interval: str,
    limit: int,
    platform: MarketPlatform = "hyperliquid",
) -> list[Candle]:
    interval_ms = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}[interval]
    end_time = int(time.time() * 1000)
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            for attempt in range(CANDLE_REQUEST_MAX_ATTEMPTS):
                if platform == "binance":
                    response = await client.get(
                        f"{BINANCE_FUTURES_URL}/fapi/v1/klines",
                        params={"symbol": f"{symbol.upper()}USDT", "interval": interval, "limit": limit},
                    )
                elif platform == "okx":
                    okx_interval = {"1h": "1H", "4h": "4H", "1d": "1Dutc"}.get(interval, interval)
                    response = await client.get(
                        f"{OKX_API_URL}/api/v5/market/candles",
                        params={"instId": f"{symbol.upper()}-USDT-SWAP", "bar": okx_interval, "limit": min(limit, 300)},
                    )
                else:
                    payload = {"type": "candleSnapshot", "req": {"coin": symbol.upper(), "interval": interval, "startTime": end_time - interval_ms * limit, "endTime": end_time}}
                    response = await client.post(HYPERLIQUID_INFO_URL, json=payload)
                status_code = getattr(response, "status_code", 200)
                if status_code not in CANDLE_RETRIABLE_STATUS_CODES or attempt + 1 >= CANDLE_REQUEST_MAX_ATTEMPTS:
                    break
                retry_after = getattr(response, "headers", {}).get("retry-after")
                try:
                    delay = float(retry_after)
                except (TypeError, ValueError):
                    delay = CANDLE_RETRY_BASE_SECONDS * (2 ** attempt)
                delay = max(0.0, min(CANDLE_RETRY_MAX_SECONDS, delay))
                logger.warning(
                    "%s K 线请求返回 %s，第 %s/%s 次尝试后等待 %.2f 秒重试",
                    platform,
                    status_code,
                    attempt + 1,
                    CANDLE_REQUEST_MAX_ATTEMPTS,
                    delay,
                )
                await asyncio.sleep(delay)
            response.raise_for_status()
        data = response.json()
        if platform == "binance":
            candles = [
                Candle(open_time=item[0], close_time=item[6], open=float(item[1]), high=float(item[2]), low=float(item[3]), close=float(item[4]), volume=float(item[5]))
                for item in data
            ]
        elif platform == "okx":
            candles = [
                Candle(open_time=int(item[0]), close_time=int(item[0]) + interval_ms - 1, open=float(item[1]), high=float(item[2]), low=float(item[3]), close=float(item[4]), volume=float(item[5]))
                for item in data["data"]
            ]
        else:
            candles = [Candle(open_time=item["t"], close_time=item["T"], open=float(item["o"]), high=float(item["h"]), low=float(item["l"]), close=float(item["c"]), volume=float(item["v"])) for item in data]
        return sorted(candles, key=lambda candle: candle.open_time)
    except (httpx.HTTPError, KeyError, IndexError, ValueError, TypeError) as exc:
        logger.warning("%s K 线数据获取失败：%s", platform, exc)
        return []


def get_news() -> list[NewsItem]:
    return fetch_live_news()


def round_price(value: float) -> float:
    """按价格量级保留有效精度，避免低价币的交易区间被舍入为同一数值。"""
    absolute = abs(value)
    digits = 2 if absolute >= 1_000 else 4 if absolute >= 1 else 6 if absolute >= 0.01 else 8
    return round(value, digits)


def _ema(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    value = sum(values[:period]) / period
    multiplier = 2 / (period + 1)
    for current in values[period:]:
        value = (current - value) * multiplier + value
    return value


def calculate_technical_indicators(candles: list[Candle]) -> TechnicalIndicators:
    """只使用已完成 K 线生成企划要求的趋势、动量和波动指标。"""
    now_ms = int(time.time() * 1000)
    completed_candles = sorted(
        (item for item in candles if item.close_time <= now_ms),
        key=lambda item: item.open_time,
    )
    closes = [item.close for item in completed_candles]
    ema20 = _ema(closes, 20)
    ema50 = _ema(closes, 50)
    ema200 = _ema(closes, 200)
    previous_ema20 = _ema(closes[:-EMA_SLOPE_LOOKBACK], 20)
    previous_ema50 = _ema(closes[:-EMA_SLOPE_LOOKBACK], 50)

    def slope_percent(current: float | None, previous: float | None) -> float | None:
        if current is None or previous is None or previous == 0:
            return None
        return (current / previous - 1) * 100

    ema20_slope_percent = slope_percent(ema20, previous_ema20)
    ema50_slope_percent = slope_percent(ema50, previous_ema50)

    rsi14 = None
    if len(closes) >= 15:
        changes = [current - previous for previous, current in zip(closes[-15:-1], closes[-14:])]
        average_gain = sum(max(change, 0) for change in changes) / 14
        average_loss = sum(max(-change, 0) for change in changes) / 14
        rsi14 = 100 if average_loss == 0 else 100 - (100 / (1 + average_gain / average_loss))

    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    macd = ema12 - ema26 if ema12 is not None and ema26 is not None else None
    macd_series: list[float] = []
    if len(closes) >= 26:
        for end in range(26, len(closes) + 1):
            fast = _ema(closes[:end], 12)
            slow = _ema(closes[:end], 26)
            if fast is not None and slow is not None:
                macd_series.append(fast - slow)
    macd_signal = _ema(macd_series, 9)

    atr14 = None
    if len(completed_candles) >= 15:
        true_ranges = []
        for previous, current in zip(completed_candles[-15:-1], completed_candles[-14:]):
            true_ranges.append(max(
                current.high - current.low,
                abs(current.high - previous.close),
                abs(current.low - previous.close),
            ))
        atr14 = sum(true_ranges) / 14

    realized_volatility = None
    positive_closes = [value for value in closes[-31:] if value > 0]
    if len(positive_closes) >= 3:
        returns = [math.log(current / previous) for previous, current in zip(positive_closes, positive_closes[1:])]
        realized_volatility = statistics.pstdev(returns) * math.sqrt(len(returns)) * 100

    volume_ratio = None
    if len(completed_candles) >= 21:
        previous_volumes = [max(0, item.volume) for item in completed_candles[-21:-1]]
        average_volume = sum(previous_volumes) / len(previous_volumes)
        if average_volume > 0:
            volume_ratio = max(0, completed_candles[-1].volume) / average_volume

    last_close = closes[-1] if closes else 0
    return TechnicalIndicators(
        ema20=round_price(ema20) if ema20 is not None else None,
        ema50=round_price(ema50) if ema50 is not None else None,
        ema200=round_price(ema200) if ema200 is not None else None,
        ema20_slope_percent=round(ema20_slope_percent, 4)
        if ema20_slope_percent is not None else None,
        ema50_slope_percent=round(ema50_slope_percent, 4)
        if ema50_slope_percent is not None else None,
        rsi14=round(rsi14, 2) if rsi14 is not None else None,
        macd=round_price(macd) if macd is not None else None,
        macd_signal=round_price(macd_signal) if macd_signal is not None else None,
        macd_histogram=round_price(macd - macd_signal) if macd is not None and macd_signal is not None else None,
        atr14=round_price(atr14) if atr14 is not None else None,
        atr_percent=round(atr14 / last_close * 100, 4) if atr14 is not None and last_close > 0 else None,
        realized_volatility=round(realized_volatility, 4) if realized_volatility is not None else None,
        volume_ratio=round(volume_ratio, 4) if volume_ratio is not None else None,
    )


def calculate_news_scores(
    symbol: str,
    direction: Literal["LONG", "SHORT", "WAIT"],
    news_items: list[NewsItem] | None,
) -> tuple[int, int, str]:
    """按相关资产、事件等级及方向一致性计算企划中的宏观和新闻得分。"""
    if not news_items or direction == "WAIT":
        return 10, 7, "当前没有可用于方向确认的相关事件，宏观与新闻维度使用中性基线"

    normalized_symbol = symbol.upper()
    relevant_news = [
        item for item in news_items
        if normalized_symbol in {asset.upper() for asset in item.assets}
        or "MARKET" in {asset.upper() for asset in item.assets}
    ][:8]
    macro_news = [
        item for item in news_items
        if {asset.upper() for asset in item.assets} & {"USD", "SPX", "NASDAQ", "MARKET"}
    ][:8]

    def aligned_score(items: list[NewsItem], baseline: int, maximum: int) -> int:
        if not items:
            return baseline
        alignment = 0
        for item in items:
            if item.direction == "neutral":
                continue
            supports_direction = (
                item.direction == "bullish" and direction == "LONG"
            ) or (
                item.direction == "bearish" and direction == "SHORT"
            )
            alignment += item.impact if supports_direction else -item.impact
        adjustment = round(alignment / max(1, len(items)) * 0.6)
        return max(0, min(maximum, baseline + adjustment))

    macro_score = aligned_score(macro_news, 10, 15)
    news_score = aligned_score(relevant_news, 7, 10)
    bullish = sum(item.direction == "bullish" for item in relevant_news)
    bearish = sum(item.direction == "bearish" for item in relevant_news)
    summary = (
        f"新闻维度参考 {len(relevant_news)} 条相关事件（利多 {bullish}、利空 {bearish}），"
        f"宏观维度参考 {len(macro_news)} 条事件"
    )
    return macro_score, news_score, summary


def calculate_optimal_entry_price(
    market: MarketSnapshot,
    direction: str,
    entry_range: list[float],
    indicators: TechnicalIndicators | None = None,
) -> float:
    """优先选择 EMA20 回踩位，并把结果限制在内部 ATR 触发带内。"""
    if direction == "WAIT" or len(entry_range) < 2:
        return round_price(market.price)
    entry_low, entry_high = sorted(entry_range[:2])
    ema20 = indicators.ema20 if indicators else None
    target = ema20 if ema20 is not None and math.isfinite(ema20) and ema20 > 0 else (entry_low + entry_high) / 2
    return round_price(max(entry_low, min(entry_high, target)))


def build_execution_levels(
    market: MarketSnapshot,
    direction: str,
    risk: str,
    indicators: TechnicalIndicators | None = None,
) -> tuple[list[float], float, list[float]]:
    """生成内部触发带，并以唯一最优入场价计算止损与止盈。"""
    if direction == "WAIT":
        reference = round_price(market.price)
        return [reference, reference], reference, [reference, reference]

    if indicators and indicators.atr14 is not None and indicators.atr14 > 0:
        atr_value = max(
            market.price * MIN_ATR_PRICE_RATE,
            min(market.price * MAX_ATR_PRICE_RATE, indicators.atr14),
        )
        direction_sign = 1 if direction == "LONG" else -1
        entry_near = market.price - direction_sign * atr_value * ENTRY_ATR_NEAR
        entry_far = market.price - direction_sign * atr_value * ENTRY_ATR_FAR
        entry_range = sorted([round_price(entry_far), round_price(entry_near)])
        optimal_entry = calculate_optimal_entry_price(market, direction, entry_range, indicators)
        risk_distance = atr_value * STOP_ATR_DISTANCE
        stop_loss = optimal_entry - direction_sign * risk_distance
        take_profit = [
            optimal_entry + direction_sign * risk_distance * FIRST_TARGET_R,
            optimal_entry + direction_sign * risk_distance * SECOND_TARGET_R,
        ]
        return (
            entry_range,
            round_price(stop_loss),
            [round_price(target) for target in take_profit],
        )

    stop_distance = {"low": 0.020, "medium": 0.026, "high": 0.035}.get(risk, 0.035)
    direction_sign = 1 if direction == "LONG" else -1
    entry_range = (
        [round_price(market.price * 0.992), round_price(market.price * 0.997)]
        if direction == "LONG"
        else [round_price(market.price * 1.003), round_price(market.price * 1.008)]
    )
    optimal_entry = calculate_optimal_entry_price(market, direction, entry_range, indicators)
    risk_distance = optimal_entry * stop_distance
    return (
        entry_range,
        round_price(optimal_entry - direction_sign * risk_distance),
        [
            round_price(optimal_entry + direction_sign * risk_distance * FIRST_TARGET_R),
            round_price(optimal_entry + direction_sign * risk_distance * SECOND_TARGET_R),
        ],
    )


def calculate_position_sizing(
    *,
    total_amount: float,
    direction: str,
    confidence: int,
    risk: str,
    entry_range: list[float],
    stop_loss: float,
    leverage: int,
    optimal_entry_price: float | None = None,
    risk_multiplier: float = 1,
) -> PositionSizing:
    """按账户风险预算和止损距离反推仓位，资金比例只作为保证金上限。"""
    margin_cap_rate = 0.30
    margin_cap = total_amount * margin_cap_rate
    if direction == "WAIT" or total_amount <= 0 or leverage <= 0 or len(entry_range) < 2:
        return PositionSizing(
            risk_budget_rate=0,
            risk_budget_amount=0,
            stop_distance_rate=0,
            margin_amount=0,
            position_value=0,
            max_loss_amount=0,
            margin_cap_rate=margin_cap_rate,
            capped=False,
        )

    entry_price = optimal_entry_price or sum(entry_range[:2]) / 2
    stop_distance_rate = abs(entry_price - stop_loss) / entry_price if entry_price > 0 else 0
    if stop_distance_rate <= 0:
        return PositionSizing(
            risk_budget_rate=0,
            risk_budget_amount=0,
            stop_distance_rate=0,
            margin_amount=0,
            position_value=0,
            max_loss_amount=0,
            margin_cap_rate=margin_cap_rate,
            capped=False,
        )

    # 高风险机会使用更低账户风险预算；置信度用于缩放，而不是直接决定资金比例。
    base_risk_rate = {"low": 0.0100, "medium": 0.0075, "high": 0.0050}.get(risk, 0.0050)
    confidence_factor = max(0, min(confidence, 100)) / 100
    risk_budget_rate = base_risk_rate * confidence_factor * max(0.5, min(1.05, risk_multiplier))
    risk_budget_amount = total_amount * risk_budget_rate
    uncapped_position_value = risk_budget_amount / stop_distance_rate
    uncapped_margin = uncapped_position_value / leverage
    margin_amount = min(uncapped_margin, margin_cap)
    position_value = margin_amount * leverage
    max_loss_amount = position_value * stop_distance_rate

    return PositionSizing(
        risk_budget_rate=round(risk_budget_rate, 6),
        risk_budget_amount=round(risk_budget_amount, 2),
        stop_distance_rate=round(stop_distance_rate, 6),
        margin_amount=round(margin_amount, 2),
        position_value=round(position_value, 2),
        max_loss_amount=round(max_loss_amount, 2),
        margin_cap_rate=margin_cap_rate,
        capped=uncapped_margin > margin_cap,
    )


def refresh_decision_plan(
    original: AnalysisResponse,
    refreshed: AnalysisResponse,
    current_price: float,
    timeframe: str,
    total_amount: float,
    now: datetime | None = None,
    candles: list[Candle] | None = None,
) -> AnalysisResponse:
    """重评决策生命周期；仅在确认错过入场且风险约束满足时生成受控修订版。"""
    now = now or datetime.now(UTC)
    try:
        generated_at = datetime.fromisoformat(original.generated_at or "")
        if generated_at.tzinfo is None:
            generated_at = generated_at.replace(tzinfo=UTC)
    except ValueError:
        return refreshed

    validity_seconds = DECISION_VALIDITY_SECONDS.get(timeframe, 14_400)
    if original.direction == "WAIT" or (now - generated_at).total_seconds() >= validity_seconds:
        return refreshed

    # 决策价格边界固定，但未执行前的仓位应跟随最新账户资金与最新评分重算。
    position_sizing = calculate_position_sizing(
        total_amount=total_amount,
        direction=original.direction,
        confidence=refreshed.score,
        risk=original.risk,
        entry_range=original.entry_range,
        stop_loss=original.stop_loss,
        leverage=original.leverage,
        optimal_entry_price=original.optimal_entry_price,
        risk_multiplier=refreshed.history_policy.applied_risk_multiplier
        if refreshed.history_policy else 1,
    )

    def keep_plan_with_review(
        *,
        decision_status: Literal[
            "watching", "confirming", "missed_entry", "executable", "invalidated", "target_reached"
        ],
        reason: str,
        is_executable: bool = False,
        soft_failure_count: int = 0,
        missed_entry_count: int = 0,
    ) -> AnalysisResponse:
        """保留当前计划价格，只更新最新评估、仓位与生命周期状态。"""
        return original.model_copy(update={
            "confidence": refreshed.confidence,
            "score": refreshed.score,
            "score_breakdown": refreshed.score_breakdown,
            "history_policy": refreshed.history_policy,
            "indicators": refreshed.indicators,
            "source": refreshed.source,
            "current_price": current_price,
            "position_sizing": position_sizing,
            "decision_status": decision_status,
            "is_executable": is_executable,
            "status_reason": reason,
            "reasons": [reason, *refreshed.reasons],
            "soft_failure_count": soft_failure_count,
            "missed_entry_count": missed_entry_count,
        })

    terminal_statuses = {"invalidated", "target_reached"}
    if original.decision_status in terminal_statuses:
        return original.model_copy(update={
            "current_price": current_price,
            "position_sizing": position_sizing,
        })

    entry_low, entry_high = sorted(original.entry_range[:2])
    first_target = original.take_profit[0]
    base_trade_score = int(refreshed.strategy_parameters.get("min_trade_score", 70))
    min_trade_score = (
        refreshed.history_policy.applied_threshold
        if refreshed.history_policy and refreshed.history_policy.applied_threshold is not None
        else base_trade_score
    )
    status: Literal[
        "watching", "confirming", "missed_entry", "executable", "invalidated", "target_reached"
    ] = "watching"
    executable = False

    generated_at_ms = int(generated_at.timestamp() * 1000)
    observed_candles = [item for item in candles or [] if item.open_time >= generated_at_ms]
    observed_high = max([current_price, *(item.high for item in observed_candles)])
    observed_low = min([current_price, *(item.low for item in observed_candles)])

    target_reached = (
        original.direction == "LONG" and observed_high >= first_target
    ) or (
        original.direction == "SHORT" and observed_low <= first_target
    )
    stop_reached = (
        original.direction == "LONG" and observed_low <= original.stop_loss
    ) or (
        original.direction == "SHORT" and observed_high >= original.stop_loss
    )

    # 同一根 K 线无法确认触发先后时按止损优先，避免高估策略表现。
    if stop_reached:
        status = "invalidated"
        reason = "价格已触及原决策结构止损，本轮计划失效"
        return keep_plan_with_review(decision_status=status, reason=reason)
    elif target_reached:
        status = "target_reached"
        reason = "价格已达到原决策首个止盈目标，本轮预测完成，禁止追价入场"
        return keep_plan_with_review(decision_status=status, reason=reason)
    else:
        direction_failure = refreshed.direction != original.direction
        severe_score_drop = refreshed.score < max(0, min_trade_score - DECISION_SCORE_HYSTERESIS)
        if direction_failure or severe_score_drop:
            soft_failure_count = min(original.soft_failure_count + 1, SOFT_FAILURE_CONFIRMATIONS)
            if soft_failure_count >= SOFT_FAILURE_CONFIRMATIONS:
                status = "invalidated"
                reason = "最新均线方向或综合评分已连续两次不满足原决策的可执行标准"
            else:
                status = "confirming"
                reason = "最新均线方向或评分首次异常，暂停执行并等待下一次复核确认"
            return keep_plan_with_review(
                decision_status=status,
                reason=reason,
                soft_failure_count=soft_failure_count,
            )

        release_score = min(100, min_trade_score + DECISION_SCORE_HYSTERESIS)
        if refreshed.direction == "WAIT" or refreshed.score < release_score:
            reason = f"最新评分处于确认缓冲区，达到 {release_score} 分且方向一致后恢复执行判断"
            return keep_plan_with_review(decision_status="confirming", reason=reason)

        reference_price = original.reference_price or sum(original.entry_range[:2]) / 2
        favorable_miss = (
            original.direction == "LONG" and current_price > max(entry_high, reference_price)
        ) or (
            original.direction == "SHORT" and current_price < min(entry_low, reference_price)
        )
        if favorable_miss:
            missed_entry_count = min(original.missed_entry_count + 1, MISSED_ENTRY_CONFIRMATIONS)
            favorable_entry = entry_high if original.direction == "LONG" else entry_low
            target_distance = abs(first_target - favorable_entry)
            missed_distance = abs(current_price - favorable_entry)
            target_progress = missed_distance / target_distance if target_distance > 0 else 1.0
            atr14 = refreshed.indicators.atr14 if refreshed.indicators else None
            within_atr = atr14 is not None and atr14 > 0 and missed_distance <= atr14 * MAX_MISSED_ENTRY_ATR
            new_entry_price = refreshed.optimal_entry_price or sum(refreshed.entry_range[:2]) / 2
            new_risk_distance = abs(new_entry_price - refreshed.stop_loss)
            new_reward_distance = abs(refreshed.take_profit[0] - new_entry_price)
            new_reward_risk = new_reward_distance / new_risk_distance if new_risk_distance > 0 else 0
            can_reprice = (
                missed_entry_count >= MISSED_ENTRY_CONFIRMATIONS
                and original.decision_revision < MAX_DECISION_REVISIONS
                and target_progress < MAX_TARGET_PROGRESS
                and within_atr
                and new_reward_risk >= MIN_REMAINING_REWARD_RISK
            )
            if can_reprice:
                revision = original.decision_revision + 1
                revision_reason = (
                    f"价格朝原方向错过入场，偏离 {missed_distance:.6g}，"
                    f"目标进度 {target_progress * 100:.1f}%，重新报价"
                )
                leverage = min(original.leverage, refreshed.leverage)
                revised_sizing = calculate_position_sizing(
                    total_amount=total_amount,
                    direction=original.direction,
                    confidence=refreshed.score,
                    risk=refreshed.risk,
                    entry_range=refreshed.entry_range,
                    stop_loss=refreshed.stop_loss,
                    leverage=leverage,
                    optimal_entry_price=refreshed.optimal_entry_price,
                    risk_multiplier=refreshed.history_policy.applied_risk_multiplier
                    if refreshed.history_policy else 1,
                )
                archived = DecisionRevisionSnapshot(
                    revision=original.decision_revision,
                    reference_price=original.reference_price,
                    entry_range=original.entry_range,
                    optimal_entry_price=original.optimal_entry_price,
                    stop_loss=original.stop_loss,
                    take_profit=original.take_profit,
                    leverage=original.leverage,
                    risk=original.risk,
                    score=original.score,
                    confidence=original.confidence,
                    generated_at=original.generated_at,
                    archived_at=now.isoformat(),
                    archive_reason="missed_entry",
                    revision_reason=original.revision_reason,
                )
                reason = f"已生成修订版 V{revision}，等待价格接近新的最优入场价"
                return original.model_copy(update={
                    "confidence": refreshed.confidence,
                    "score": refreshed.score,
                    "score_breakdown": refreshed.score_breakdown,
                    "history_policy": refreshed.history_policy,
                    "entry_range": refreshed.entry_range,
                    "optimal_entry_price": refreshed.optimal_entry_price,
                    "stop_loss": refreshed.stop_loss,
                    "take_profit": refreshed.take_profit,
                    "leverage": leverage,
                    "risk": refreshed.risk,
                    "position_sizing": revised_sizing,
                    "indicators": refreshed.indicators,
                    "reasons": [reason, revision_reason, *refreshed.reasons],
                    "source": refreshed.source,
                    "analysis_engine": refreshed.analysis_engine,
                    "analysis_model": refreshed.analysis_model,
                    "decision_schema_version": refreshed.decision_schema_version,
                    "strategy_version": refreshed.strategy_version,
                    "strategy_parameters": refreshed.strategy_parameters,
                    "reference_price": current_price,
                    "current_price": current_price,
                    "generated_at": now.isoformat(),
                    "decision_revision": revision,
                    "revision_reason": revision_reason,
                    "revision_history": [*original.revision_history, archived],
                    "soft_failure_count": 0,
                    "missed_entry_count": 0,
                    "decision_status": "watching",
                    "is_executable": False,
                    "status_reason": reason,
                })

            status = "missed_entry"
            if original.decision_revision >= MAX_DECISION_REVISIONS:
                reason = "已达到最多两次重新报价上限，等待回踩原修订区间"
            elif target_progress >= MAX_TARGET_PROGRESS:
                reason = f"原目标路径已完成 {target_progress * 100:.1f}%，禁止追价重新报价"
            elif not within_atr:
                reason = "价格偏离超过 0.5 ATR 或 ATR 数据不足，等待回踩"
            elif missed_entry_count < MISSED_ENTRY_CONFIRMATIONS:
                reason = "首次确认错过入场，等待下一次复核后再决定是否重新报价"
            else:
                reason = f"新计划剩余盈亏比 {new_reward_risk:.2f} 不足，等待回踩"
            return keep_plan_with_review(
                decision_status=status,
                reason=reason,
                missed_entry_count=missed_entry_count,
            )

    if entry_low <= current_price <= entry_high:
        risk_distance = abs(current_price - original.stop_loss)
        remaining_reward = abs(first_target - current_price)
        reward_risk = remaining_reward / risk_distance if risk_distance > 0 else 0
        if reward_risk >= MIN_REMAINING_REWARD_RISK:
            status = "executable"
            executable = True
            reason = f"价格进入最优入场价的有效触发范围，最新评分 {refreshed.score} 分，剩余盈亏比 {reward_risk:.2f}"
        else:
            reason = f"价格虽接近最优入场价，但剩余盈亏比 {reward_risk:.2f} 低于 {MIN_REMAINING_REWARD_RISK:.1f}"
    elif original.direction == "LONG" and current_price > entry_high:
        reason = "价格高于最优入场价的有效触发范围，等待回踩，禁止追涨"
    elif original.direction == "SHORT" and current_price < entry_low:
        reason = "价格低于最优入场价的有效触发范围，等待反弹，禁止追空"
    else:
        reason = "价格已穿过最优入场价但尚未触及止损，等待重新接近计划价"

    return keep_plan_with_review(
        decision_status=status,
        reason=reason,
        is_executable=executable,
    )


def analyze_market(
    payload: AnalysisRequest,
    market: MarketSnapshot | None = None,
    total_amount: float = 10_000,
    indicators: TechnicalIndicators | None = None,
    strategy_version: str = "v1",
    strategy_parameters: dict | None = None,
    news_items: list[NewsItem] | None = None,
    history_policy: DecisionHistoryPolicy | None = None,
) -> AnalysisResponse:
    market = market or MARKETS[payload.symbol.upper()]
    symbol = market.symbol
    # 五维权重与企划保持一致；均线方向是生成可执行决策前不可绕过的硬门槛。
    trend_score = max(0, min(30, round(18 + abs(market.change_24h) * 2)))
    structure_score = max(0, min(25, round(17 + abs(market.change_24h) - market.volatility * 0.8)))
    indicator_direction: Literal["LONG", "SHORT", "WAIT"] = "WAIT"
    moving_average_reason = "EMA20/50/200 数据不足，均线方向无法确认"
    technical_gate_reason = moving_average_reason
    technical_gate_passed = False
    if indicators and all(value is not None for value in (indicators.ema20, indicators.ema50, indicators.ema200)):
        if indicators.ema20 > indicators.ema50 > indicators.ema200:
            indicator_direction = "LONG"
            trend_score = 30
            moving_average_reason = "EMA20 > EMA50 > EMA200，均线形成明确多头排列"
        elif indicators.ema20 < indicators.ema50 < indicators.ema200:
            indicator_direction = "SHORT"
            trend_score = 30
            moving_average_reason = "EMA20 < EMA50 < EMA200，均线形成明确空头排列"
        else:
            trend_score = min(trend_score, 20)
            moving_average_reason = "EMA20/50/200 交叉、走平或排列混乱，均线方向不明确"
        if indicators.rsi14 is not None:
            structure_score = max(8, min(25, round(25 - abs(indicators.rsi14 - 50) * 0.25)))

        if indicator_direction != "WAIT":
            ema_spread_percent = abs(indicators.ema20 - indicators.ema200) / market.price * 100
            atr_spread_threshold = (
                indicators.atr_percent * MAX_EMA_SPREAD_ATR_FACTOR
                if indicators.atr_percent is not None and indicators.atr_percent > 0 else 0
            )
            required_spread_percent = max(
                MIN_EMA_SPREAD_PERCENT,
                min(MAX_EMA_SPREAD_THRESHOLD, atr_spread_threshold),
            )
            gate_failures: list[str] = []
            if ema_spread_percent < required_spread_percent:
                gate_failures.append(
                    f"均线总间距仅 {ema_spread_percent:.2f}%，低于 {required_spread_percent:.2f}%"
                )
            if indicator_direction == "LONG" and market.price < indicators.ema50:
                gate_failures.append("当前价格跌破 EMA50，多头价格结构未确认")
            elif indicator_direction == "SHORT" and market.price > indicators.ema50:
                gate_failures.append("当前价格站上 EMA50，空头价格结构未确认")

            if indicators.rsi14 is not None:
                if indicator_direction == "LONG" and indicators.rsi14 >= LONG_RSI_EXHAUSTION:
                    gate_failures.append(f"RSI14 为 {indicators.rsi14:.2f}，多头处于过热区")
                elif indicator_direction == "SHORT" and indicators.rsi14 <= SHORT_RSI_EXHAUSTION:
                    gate_failures.append(f"RSI14 为 {indicators.rsi14:.2f}，空头处于过冷区")

            if indicators.ema20_slope_percent is not None and indicators.ema50_slope_percent is not None:
                slope_conflict = (
                    indicator_direction == "LONG"
                    and (indicators.ema20_slope_percent <= 0 or indicators.ema50_slope_percent <= 0)
                    or indicator_direction == "SHORT"
                    and (indicators.ema20_slope_percent >= 0 or indicators.ema50_slope_percent >= 0)
                )
                if slope_conflict:
                    gate_failures.append(
                        "EMA20 与 EMA50 斜率未共同支持当前均线方向"
                    )

            if indicators.volume_ratio is not None and indicators.volume_ratio < MIN_VOLUME_RATIO:
                gate_failures.append(
                    f"最新成交量仅为近 20 根均量的 {indicators.volume_ratio:.2f} 倍，量能不足"
                )

            crowded_funding = (
                indicator_direction == "LONG" and market.funding_rate >= MAX_CROWDED_FUNDING_RATE
                or indicator_direction == "SHORT" and market.funding_rate <= -MAX_CROWDED_FUNDING_RATE
            )
            if crowded_funding:
                gate_failures.append(
                    f"资金费率 {market.funding_rate:.4f}% 与方向同侧过度拥挤"
                )

            momentum_conflict = (
                indicators.macd_histogram is not None
                and indicators.rsi14 is not None
                and (
                    indicator_direction == "LONG"
                    and indicators.macd_histogram < 0
                    and indicators.rsi14 < 50
                    or indicator_direction == "SHORT"
                    and indicators.macd_histogram > 0
                    and indicators.rsi14 > 50
                )
            )
            if momentum_conflict:
                gate_failures.append("MACD 柱与 RSI 同时反向，短期动量不支持均线方向")

            if indicators.atr14 is not None and indicators.atr14 > 0:
                ema20_distance_atr = abs(market.price - indicators.ema20) / indicators.atr14
                overextended = (
                    indicator_direction == "LONG" and market.price > indicators.ema20
                    or indicator_direction == "SHORT" and market.price < indicators.ema20
                ) and ema20_distance_atr > MAX_ENTRY_STRETCH_ATR
                if overextended:
                    gate_failures.append(
                        f"价格偏离 EMA20 达 {ema20_distance_atr:.2f} ATR，当前不宜追价"
                    )

            if gate_failures:
                trend_score = min(trend_score, 20)
                structure_score = min(structure_score, 15)
                technical_gate_reason = "技术准入未通过：" + "；".join(gate_failures)
            else:
                technical_gate_passed = True
                technical_gate_reason = (
                    f"{moving_average_reason}；均线总间距 {ema_spread_percent:.2f}% "
                    f"达到 {required_spread_percent:.2f}% 的趋势强度要求"
                )
    direction = indicator_direction
    if not technical_gate_passed:
        direction = "WAIT"
    capital_score = max(0, min(20, round(15 - abs(market.funding_rate) * 100)))
    macro_score, news_score, news_reason = calculate_news_scores(
        symbol, direction, news_items
    )
    raw_score_breakdown = {
        "trend": trend_score,
        "structure": structure_score,
        "capital": capital_score,
        "macro": macro_score,
        "news": news_score,
    }
    normalized_parameters = normalize_strategy_parameters(strategy_parameters)
    score_breakdown = apply_strategy_weights(raw_score_breakdown, normalized_parameters)
    score = sum(score_breakdown.values())
    min_trade_score = int(normalized_parameters["min_trade_score"])
    effective_threshold, history_risk_multiplier, applied_history_policy = apply_history_policy(
        min_trade_score,
        direction,
        history_policy,
    )
    # 企划将 50–69 分定义为观察区，只有 70 分以上才生成可执行方向。
    if score < effective_threshold:
        direction = "WAIT"
    risk = "high" if market.volatility > 6 else "medium" if market.volatility > 3 else "low"
    entry_range, stop_loss, take_profit = build_execution_levels(
        market, direction, risk, indicators
    )
    optimal_entry_price = calculate_optimal_entry_price(market, direction, entry_range, indicators)
    leverage = 3 if risk == "medium" else 2
    position_sizing = calculate_position_sizing(
        total_amount=total_amount,
        direction=direction,
        confidence=score,
        risk=risk,
        entry_range=entry_range,
        stop_loss=stop_loss,
        leverage=leverage,
        optimal_entry_price=optimal_entry_price,
        risk_multiplier=history_risk_multiplier,
    )
    generated_at = datetime.now(UTC).isoformat()
    if not technical_gate_passed:
        status_reason = f"{technical_gate_reason}，不生成可执行决策"
    elif direction == "WAIT":
        status_reason = "均线方向明确，但当前评分尚未达到可执行标准"
    else:
        status_reason = "已生成固定交易计划，等待价格接近最优入场价"
    return AnalysisResponse(
        symbol=symbol,
        instrument=f"{symbol}-PERP",
        direction=direction,
        confidence=score,
        score=score,
        score_breakdown=score_breakdown,
        entry_range=entry_range,
        optimal_entry_price=optimal_entry_price,
        stop_loss=stop_loss,
        take_profit=take_profit,
        leverage=leverage,
        risk=risk,
        position_sizing=position_sizing,
        indicators=indicators,
        reasons=[
            f"24 小时涨跌 {market.change_24h:.2f}%，趋势维度获得 {trend_score}/30 分",
            f"当前波动率 {market.volatility:.2f}%，技术结构维度获得 {structure_score}/25 分",
            f"资金费率 {market.funding_rate:.4f}%，资金维度获得 {capital_score}/20 分",
            (
                f"EMA20/50/200 为 {indicators.ema20}/{indicators.ema50}/{indicators.ema200}，"
                f"RSI14 为 {indicators.rsi14}，ATR 占比 {indicators.atr_percent}%"
                if indicators else "K 线指标暂不可用，本次仅使用市场快照评分"
            ),
            technical_gate_reason,
            (
                "入场、止损与止盈按 ATR 回踩区及 2R/3R 目标生成"
                if direction != "WAIT" and indicators and indicators.atr14 is not None
                else "当前使用固定百分比价格模型或处于观望状态"
            ),
            news_reason,
            (
                f"策略版本 {strategy_version}，基础可交易阈值 {min_trade_score} 分；"
                f"五维权重为趋势 {normalized_parameters['trend_weight']}、"
                f"技术结构 {normalized_parameters['structure_weight']}、"
                f"资金 {normalized_parameters['capital_weight']}、"
                f"宏观 {normalized_parameters['macro_weight']}、"
                f"新闻 {normalized_parameters['news_weight']}"
            ),
            (
                f"历史策略参考 {applied_history_policy.sample_count} 笔去重模拟决策，"
                f"胜率 {applied_history_policy.win_rate:.1f}%，"
                f"近 6 笔胜率 {applied_history_policy.recent_win_rate:.1f}%，"
                f"当前准入阈值 {effective_threshold} 分，"
                f"风险预算系数 {history_risk_multiplier:.2f}"
                if applied_history_policy
                else f"历史有效样本不足 {HISTORY_POLICY_MIN_SAMPLES} 笔，本次沿用基础决策策略"
            ),
        ],
        disclaimer="仅供研究与辅助决策，不构成投资建议；系统不会自动下单。",
        source=market.source,
        platform=market.platform,
        funding_rate=market.funding_rate,
        strategy_version=strategy_version,
        strategy_parameters=normalized_parameters,
        history_policy=applied_history_policy,
        reference_price=market.price,
        current_price=market.price,
        generated_at=generated_at,
        decision_status="watching",
        is_executable=False,
        status_reason=status_reason,
    )


async def get_live_wallet(address: str) -> WalletSnapshot:
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            state_response = await client.post(HYPERLIQUID_INFO_URL, json={"type": "clearinghouseState", "user": address})
            history_response = await client.post(HYPERLIQUID_INFO_URL, json={"type": "userFills", "user": address})
            state_response.raise_for_status()
            history_response.raise_for_status()
        state = state_response.json()
        summary = state.get("marginSummary", {})
        positions = [item.get("position", {}) for item in state.get("assetPositions", [])]
        return WalletSnapshot(
            address=address,
            equity=float(summary.get("accountValue") or 0),
            available_balance=float(state.get("withdrawable") or 0),
            unrealized_pnl=sum(float(item.get("unrealizedPnl") or 0) for item in positions),
            positions=positions,
            history=history_response.json()[:100],
            source="live",
            platform="hyperliquid",
        )
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        logger.warning("Hyperliquid 钱包数据获取失败：%s", exc)
        return WalletSnapshot(
            address=address,
            equity=0,
            available_balance=0,
            unrealized_pnl=0,
            positions=[],
            history=[],
            source="unavailable",
            error="Hyperliquid 数据暂时不可用",
            platform="hyperliquid",
        )


async def get_user_fills_by_time(address: str, start_time: int) -> list[dict]:
    """读取决策开始后的真实成交，供完成交易时结算使用。"""
    try:
        end_time = int(time.time() * 1000)
        cursor = start_time
        fills: list[dict] = []
        seen: set[tuple] = set()
        async with httpx.AsyncClient(timeout=6.0) as client:
            # 官方仅保留最近 10,000 条成交；最多读取 20 页，避免异常响应导致死循环。
            for _ in range(20):
                response = await client.post(
                    HYPERLIQUID_INFO_URL,
                    json={
                        "type": "userFillsByTime",
                        "user": address,
                        "startTime": cursor,
                        "endTime": end_time,
                        "aggregateByTime": True,
                    },
                )
                response.raise_for_status()
                page = response.json()
                if not isinstance(page, list) or not page:
                    break
                for fill in page:
                    key = (
                        fill.get("tid"), fill.get("hash"), fill.get("time"),
                        fill.get("coin"), fill.get("px"), fill.get("sz"), fill.get("side"),
                    )
                    if key not in seen:
                        seen.add(key)
                        fills.append(fill)
                last_time = max(int(fill.get("time") or 0) for fill in page)
                if last_time < cursor or last_time >= end_time:
                    break
                cursor = last_time + 1
        return sorted(fills, key=lambda fill: int(fill.get("time") or 0))
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        logger.warning("Hyperliquid 成交历史获取失败：%s", exc)
        return []
