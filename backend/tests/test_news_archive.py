from datetime import date, timedelta

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import ArchivedNews
from app.news_archive import archive_news
from app.schemas import NewsItem


def make_news(index: int) -> NewsItem:
    return NewsItem(
        id=index,
        title=f"新闻 {index}",
        source="测试来源",
        published_at=f"{index}:00",
        impact=3,
        assets=["BTC"],
        direction="neutral",
        analysis=f"分析 {index}",
    )


def test_news_archive_has_no_daily_limit_and_deduplicates():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine)
    today = date(2026, 9, 11)
    items = [make_news(index) for index in range(1, 13)]

    with testing_session() as session:
        assert archive_news(session, items, today) == 12
        assert archive_news(session, items, today) == 0
        assert archive_news(session, [items[0]], today - timedelta(days=1)) == 1

        today_rows = session.scalars(
            select(ArchivedNews).where(ArchivedNews.archive_date == today)
        ).all()
        yesterday_rows = session.scalars(
            select(ArchivedNews).where(ArchivedNews.archive_date == today - timedelta(days=1))
        ).all()

    assert len(today_rows) == 12
    assert len(yesterday_rows) == 1
