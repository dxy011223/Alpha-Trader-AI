import html
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

import httpx

from app.config import get_settings
from app.schemas import NewsItem

logger = logging.getLogger(__name__)
SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
USER_AGENT = "AlphaTraderAI/1.0 (+read-only market research)"


@dataclass(frozen=True)
class RssSource:
    name: str
    url: str


RSS_SOURCES = (
    RssSource("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    RssSource("CNBC Markets", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    RssSource("Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml"),
)

_cache_lock = threading.Lock()
_cached_at = 0.0
_cached_items: list[NewsItem] = []

ASSET_KEYWORDS = {
    "BTC": ("bitcoin", "btc"),
    "ETH": ("ethereum", "ether", "eth"),
    "SOL": ("solana", "sol"),
    "NASDAQ": ("nasdaq", "tech stocks", "technology stocks"),
    "SPX": ("s&p 500", "stock market", "stocks", "equities"),
    "USD": ("federal reserve", "fed ", "interest rate", "inflation", "dollar"),
}
POSITIVE_KEYWORDS = (
    "surge", "rise", "rally", "gain", "growth", "approval", "inflow", "cut rates", "rate cut",
    "上升", "上涨", "增长", "批准", "流入", "降息",
)
NEGATIVE_KEYWORDS = (
    "fall", "drop", "decline", "selloff", "ban", "hack", "outflow", "raise rates", "rate hike",
    "下降", "下跌", "禁令", "攻击", "流出", "加息",
)
HIGH_IMPACT_KEYWORDS = (
    "federal reserve", "interest rate", "inflation", "cpi", "sec", "etf", "hack", "ban", "tariff",
    "美联储", "利率", "通胀", "监管", "黑客", "关税",
)


def _plain_text(value: str | None) -> str:
    if not value:
        return ""
    without_tags = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(without_tags)).strip()


def _published_datetime(value: str | None, now: datetime) -> datetime:
    if value:
        try:
            parsed = parsedate_to_datetime(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            return parsed.astimezone(SHANGHAI_TZ)
        except (TypeError, ValueError, OverflowError):
            pass
    return now.astimezone(SHANGHAI_TZ)


def _classify(title: str, summary: str) -> tuple[int, list[str], str, str]:
    content = f"{title} {summary}".lower()
    assets = [
        symbol
        for symbol, keywords in ASSET_KEYWORDS.items()
        if any(keyword in content for keyword in keywords)
    ]
    if not assets:
        assets = ["MARKET"]

    positive_hits = sum(keyword in content for keyword in POSITIVE_KEYWORDS)
    negative_hits = sum(keyword in content for keyword in NEGATIVE_KEYWORDS)
    direction = "bullish" if positive_hits > negative_hits else "bearish" if negative_hits > positive_hits else "neutral"
    impact = min(
        5,
        2
        + int(any(keyword in content for keyword in HIGH_IMPACT_KEYWORDS))
        + int(len(assets) > 1)
        + int(len(assets) > 2),
    )
    direction_text = {"bullish": "偏利多", "bearish": "偏利空", "neutral": "影响方向尚不明确"}[direction]
    analysis = f"新闻关键词显示{direction_text}，影响范围为{'、'.join(assets)}；需结合价格与成交量确认。"
    return impact, assets, direction, analysis


def parse_rss_feed(content: bytes, source: RssSource, now: datetime | None = None) -> list[NewsItem]:
    """解析一个 RSS 源；只保留标题、来源和短摘要，不复制正文。"""
    current_time = now or datetime.now(UTC)
    root = ElementTree.fromstring(content)
    items: list[NewsItem] = []
    for index, node in enumerate(root.findall(".//item"), start=1):
        title = _plain_text(node.findtext("title"))[:300]
        if not title:
            continue
        summary = _plain_text(node.findtext("description"))[:600]
        published = _published_datetime(node.findtext("pubDate"), current_time)
        impact, assets, direction, analysis = _classify(title, summary)
        items.append(NewsItem(
            id=index,
            title=title,
            source=source.name,
            published_at=published.strftime("%Y-%m-%d %H:%M"),
            impact=impact,
            assets=assets,
            direction=direction,
            analysis=analysis,
        ))
    return items


def _fetch_source(source: RssSource) -> list[NewsItem]:
    try:
        with httpx.Client(timeout=8.0, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
            response = client.get(source.url)
            response.raise_for_status()
        return parse_rss_feed(response.content, source)
    except (httpx.HTTPError, ElementTree.ParseError, ValueError) as exc:
        logger.warning("新闻源 %s 获取失败，已跳过该来源：%s", source.name, exc)
        return []


def fetch_live_news(force: bool = False) -> list[NewsItem]:
    """并发读取真实 RSS；短时缓存可避免前端刷新造成重复外部请求。"""
    global _cached_at, _cached_items
    refresh_seconds = max(30, get_settings().news_refresh_seconds)
    with _cache_lock:
        if not force and _cached_items and time.monotonic() - _cached_at < refresh_seconds:
            return list(_cached_items)

    with ThreadPoolExecutor(max_workers=len(RSS_SOURCES)) as executor:
        source_results = list(executor.map(_fetch_source, RSS_SOURCES))

    unique_items: list[NewsItem] = []
    seen: set[tuple[str, str]] = set()
    for item in sorted((item for result in source_results for item in result), key=lambda entry: entry.published_at, reverse=True):
        key = (item.source.casefold(), item.title.casefold())
        if key in seen:
            continue
        seen.add(key)
        unique_items.append(item.model_copy(update={"id": len(unique_items) + 1}))

    if unique_items:
        with _cache_lock:
            _cached_at = time.monotonic()
            _cached_items = unique_items
    else:
        logger.warning("所有实时新闻源均不可用，本次不会生成演示新闻")
    return list(unique_items)


def news_archive_date(item: NewsItem) -> date:
    """RSS 时间已统一为北京时间，归档日期直接取其日期部分。"""
    try:
        return datetime.strptime(item.published_at, "%Y-%m-%d %H:%M").date()
    except ValueError:
        return current_news_date()


def current_news_date() -> date:
    return datetime.now(SHANGHAI_TZ).date()
