from datetime import date
from hashlib import sha256

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import ArchivedNews
from app.schemas import NewsArchiveResponse, NewsItem
from app.services import get_news


def _fingerprint(item: NewsItem, archive_date: date) -> str:
    value = f"{archive_date.isoformat()}|{item.source.strip()}|{item.title.strip()}"
    return sha256(value.encode("utf-8")).hexdigest()


def archive_news(session: Session, items: list[NewsItem], archive_date: date) -> int:
    """按日期、来源和标题去重归档；不限制单日新闻数量。"""
    fingerprints = {_fingerprint(item, archive_date) for item in items}
    existing = set(session.scalars(
        select(ArchivedNews.fingerprint).where(ArchivedNews.fingerprint.in_(fingerprints))
    )) if fingerprints else set()
    inserted = 0
    for item in items:
        fingerprint = _fingerprint(item, archive_date)
        if fingerprint in existing:
            continue
        session.add(ArchivedNews(
            fingerprint=fingerprint,
            archive_date=archive_date,
            title=item.title,
            source=item.source,
            published_at=item.published_at,
            impact=item.impact,
            assets=item.assets,
            direction=item.direction,
            analysis=item.analysis,
        ))
        existing.add(fingerprint)
        inserted += 1
    session.commit()
    return inserted


def get_news_archive(target_date: date) -> NewsArchiveResponse:
    """返回指定日期的全部归档；读取今天时先同步当前新闻源。"""
    with SessionLocal() as session:
        if target_date == date.today():
            archive_news(session, get_news(), target_date)
        rows = session.scalars(
            select(ArchivedNews)
            .where(ArchivedNews.archive_date == target_date)
            .order_by(ArchivedNews.created_at.desc(), ArchivedNews.id.desc())
        ).all()
        items = [
            NewsItem(
                id=row.id,
                title=row.title,
                source=row.source,
                published_at=row.published_at,
                impact=row.impact,
                assets=row.assets,
                direction=row.direction,
                analysis=row.analysis,
            )
            for row in rows
        ]
    return NewsArchiveResponse(date=target_date.isoformat(), total=len(items), items=items)
