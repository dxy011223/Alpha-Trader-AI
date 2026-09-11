import logging
import time

import httpx

from app.schemas import AnalysisRequest, AnalysisResponse, Candle, MarketSnapshot, NewsItem, PositionSizing, ReviewReport, WalletSnapshot

logger = logging.getLogger(__name__)
HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info"


MARKETS = {
    "BTC": MarketSnapshot(symbol="BTC", price=82437.20, change_24h=2.84, volume=28_460_000_000, volatility=3.12, funding_rate=0.0102, open_interest=18_720_000_000),
    "ETH": MarketSnapshot(symbol="ETH", price=3548.76, change_24h=1.92, volume=14_820_000_000, volatility=3.86, funding_rate=0.0084, open_interest=9_640_000_000),
    "SOL": MarketSnapshot(symbol="SOL", price=179.42, change_24h=-0.74, volume=3_960_000_000, volatility=5.14, funding_rate=-0.0021, open_interest=2_180_000_000),
    "HYPE": MarketSnapshot(symbol="HYPE", price=39.28, change_24h=4.63, volume=642_000_000, volatility=6.42, funding_rate=0.0148, open_interest=782_000_000),
}


def get_market(symbol: str) -> MarketSnapshot | None:
    return MARKETS.get(symbol.upper())


async def get_live_markets() -> list[MarketSnapshot]:
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
                ))
            except (KeyError, ValueError, TypeError):
                # 单个市场字段异常时继续扫描，不影响其余候选品种。
                continue
        return markets
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        logger.warning("全市场实时行情获取失败，已回退到演示数据：%s", exc)
        return list(MARKETS.values())


async def get_live_market(symbol: str) -> MarketSnapshot | None:
    """从全市场快照中读取指定品种，网络异常时保留核心币种演示数据。"""
    normalized_symbol = symbol.upper()
    markets = await get_live_markets()
    return next((market for market in markets if market.symbol == normalized_symbol), get_market(normalized_symbol))


async def get_candles(symbol: str, interval: str, limit: int) -> list[Candle]:
    interval_ms = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}[interval]
    end_time = int(time.time() * 1000)
    payload = {"type": "candleSnapshot", "req": {"coin": symbol.upper(), "interval": interval, "startTime": end_time - interval_ms * limit, "endTime": end_time}}
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            response = await client.post(HYPERLIQUID_INFO_URL, json=payload)
            response.raise_for_status()
        return [Candle(open_time=item["t"], close_time=item["T"], open=float(item["o"]), high=float(item["h"]), low=float(item["l"]), close=float(item["c"]), volume=float(item["v"])) for item in response.json()]
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        logger.warning("K 线数据获取失败：%s", exc)
        return []


def get_news() -> list[NewsItem]:
    return [
        NewsItem(id=1, title="美联储官员释放谨慎降息信号", source="Macro Wire", published_at="12 分钟前", impact=4, assets=["BTC", "NASDAQ"], direction="bullish", analysis="流动性预期改善，中期偏利多风险资产。"),
        NewsItem(id=2, title="现货比特币 ETF 连续三个交易日净流入", source="Crypto Brief", published_at="38 分钟前", impact=4, assets=["BTC"], direction="bullish", analysis="机构买盘提供支撑，但短线涨幅扩大后需警惕获利回吐。"),
        NewsItem(id=3, title="亚洲市场风险偏好小幅回落", source="Global Markets", published_at="1 小时前", impact=2, assets=["ETH", "SOL"], direction="neutral", analysis="影响有限，尚未改变主要趋势结构。"),
    ]


def round_price(value: float) -> float:
    """按价格量级保留有效精度，避免低价币的交易区间被舍入为同一数值。"""
    absolute = abs(value)
    digits = 2 if absolute >= 1_000 else 4 if absolute >= 1 else 6 if absolute >= 0.01 else 8
    return round(value, digits)


def calculate_position_sizing(
    *,
    total_amount: float,
    direction: str,
    confidence: int,
    risk: str,
    entry_range: list[float],
    stop_loss: float,
    leverage: int,
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

    entry_mid = sum(entry_range[:2]) / 2
    stop_distance_rate = abs(entry_mid - stop_loss) / entry_mid if entry_mid > 0 else 0
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
    risk_budget_rate = base_risk_rate * confidence_factor
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


def analyze_market(payload: AnalysisRequest, market: MarketSnapshot | None = None, total_amount: float = 10_000) -> AnalysisResponse:
    market = market or MARKETS[payload.symbol.upper()]
    symbol = market.symbol
    # 五维权重与企划保持一致，总分用于判断机会质量，方向由价格动能单独判断。
    trend_score = max(0, min(30, round(18 + market.change_24h * 2)))
    structure_score = max(0, min(25, round(17 + market.change_24h - market.volatility * 0.8)))
    capital_score = max(0, min(20, round(15 - abs(market.funding_rate) * 100)))
    macro_score = 10
    news_score = 7
    score_breakdown = {
        "trend": trend_score,
        "structure": structure_score,
        "capital": capital_score,
        "macro": macro_score,
        "news": news_score,
    }
    score = sum(score_breakdown.values())
    direction = "LONG" if market.change_24h >= 1 else "SHORT" if market.change_24h <= -1 else "WAIT"
    if score < 50:
        direction = "WAIT"
    risk = "high" if market.volatility > 6 else "medium" if market.volatility > 3 else "low"
    entry_range = [round_price(market.price * 0.992), round_price(market.price * 0.997)]
    stop_loss = round_price(market.price * 0.974)
    leverage = 3 if risk == "medium" else 2
    position_sizing = calculate_position_sizing(
        total_amount=total_amount,
        direction=direction,
        confidence=score,
        risk=risk,
        entry_range=entry_range,
        stop_loss=stop_loss,
        leverage=leverage,
    )
    return AnalysisResponse(
        symbol=symbol,
        instrument=f"{symbol}-PERP",
        direction=direction,
        confidence=score,
        score=score,
        score_breakdown=score_breakdown,
        entry_range=entry_range,
        stop_loss=stop_loss,
        take_profit=[round_price(market.price * 1.035), round_price(market.price * 1.072)],
        leverage=leverage,
        risk=risk,
        position_sizing=position_sizing,
        reasons=[
            f"24 小时涨跌 {market.change_24h:.2f}%，趋势维度获得 {trend_score}/30 分",
            f"当前波动率 {market.volatility:.2f}%，技术结构维度获得 {structure_score}/25 分",
            f"资金费率 {market.funding_rate:.4f}%，资金维度获得 {capital_score}/20 分",
            "宏观与新闻暂未出现否决性风险，重大事件发生时需要重新评估",
        ],
        disclaimer="仅供研究与辅助决策，不构成投资建议；系统不会自动下单。",
        source=market.source,
    )


def get_wallet(address: str) -> WalletSnapshot:
    return WalletSnapshot(address=address, equity=24380.62, available_balance=18240.17, unrealized_pnl=428.36, positions=[{"symbol": "BTC-PERP", "direction": "LONG", "size": 0.072, "entry_price": 79240.0, "mark_price": 82437.2, "leverage": 3, "pnl": 230.2}], history=[])


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
            history=history_response.json()[:50],
            source="live",
        )
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        logger.warning("钱包数据获取失败，已回退到演示数据：%s", exc)
        return get_wallet(address)


def create_review() -> ReviewReport:
    return ReviewReport(period="近 100 次决策", total=100, correct=63, incorrect=37, win_rate=63.0, findings=["突破策略在高波动环境下胜率下降", "高资金费率环境追多的回撤更大"], adjustments=["降低突破策略权重 15%", "提高资金指标权重 10%"])
