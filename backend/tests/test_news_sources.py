from datetime import UTC, date, datetime

from app.news_sources import RssSource, news_archive_date, parse_rss_feed


def test_parse_rss_feed_uses_real_publish_time_and_classifies_assets():
    feed = b"""<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><item>
      <title>Bitcoin ETF inflow rises as Federal Reserve signals rate cut</title>
      <description><![CDATA[<p>Crypto and stocks gain.</p>]]></description>
      <pubDate>Fri, 11 Sep 2026 01:30:00 GMT</pubDate>
    </item></channel></rss>"""

    items = parse_rss_feed(
        feed,
        RssSource("测试真实源", "https://example.com/feed.xml"),
        now=datetime(2026, 9, 11, tzinfo=UTC),
    )

    assert len(items) == 1
    item = items[0]
    assert item.source == "测试真实源"
    assert item.published_at == "2026-09-11 09:30"
    assert news_archive_date(item) == date(2026, 9, 11)
    assert {"BTC", "SPX", "USD"}.issubset(item.assets)
    assert item.direction == "bullish"
    assert item.impact == 5


def test_parse_rss_feed_skips_items_without_title():
    feed = b"<rss><channel><item><description>missing title</description></item></channel></rss>"

    assert parse_rss_feed(feed, RssSource("测试源", "https://example.com")) == []
