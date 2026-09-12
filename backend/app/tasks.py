import asyncio
import logging
from datetime import timedelta

from app.ai_analysis import enrich_review_with_openai
from app.celery_app import celery_app
from app.database import Base, engine
from app.market_scanner import run_scheduled_market_scan
from app.news_sources import current_news_date, fetch_live_news
from app.position_monitor import monitor_active_positions
from app.trade_records import generate_daily_review, update_review_content
from app.strategy_versions import build_strategy_optimization_context, record_daily_performance

logger = logging.getLogger(__name__)


@celery_app.task(name="alpha_trader.scan_market")
def scheduled_market_scan() -> dict:
    Base.metadata.create_all(bind=engine)
    fetch_live_news()
    results = {
        platform: asyncio.run(run_scheduled_market_scan("4h", 8, platform))
        for platform in ("hyperliquid", "binance", "okx")
    }
    logger.info(
        "定时市场扫描完成：平台 %s 个，扫描市场 %s 个，输出机会 %s 个",
        len(results),
        sum(item.scanned_markets for item in results.values()),
        sum(len(item.opportunities) for item in results.values()),
    )
    return {platform: result.model_dump(mode="json") for platform, result in results.items()}


@celery_app.task(name="alpha_trader.daily_review")
def scheduled_daily_review() -> dict:
    Base.metadata.create_all(bind=engine)
    target_date = current_news_date() - timedelta(days=1)
    results = {}
    for platform in ("hyperliquid", "binance", "okx"):
        result = generate_daily_review(target_date, platform)
        strategy_context = build_strategy_optimization_context(result)
        result = asyncio.run(enrich_review_with_openai(
            result,
            {
                "period": target_date.isoformat(),
                "platform": platform,
                "strategy_optimization": strategy_context,
            },
        ))
        results[platform] = record_daily_performance(update_review_content(result))
    logger.info(
        "每日复盘与策略优化完成：日期 %s，平台 %s 个",
        target_date.isoformat(),
        len(results),
    )
    return {platform: result.model_dump(mode="json") for platform, result in results.items()}


@celery_app.task(name="alpha_trader.monitor_positions")
def scheduled_position_monitor() -> list[dict]:
    Base.metadata.create_all(bind=engine)
    results = asyncio.run(monitor_active_positions())
    logger.info("活动持仓监控完成：更新 %s 个持仓建议", len(results))
    return [item.model_dump(mode="json") for item in results]
