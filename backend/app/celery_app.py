from datetime import timedelta

from celery import Celery
from celery.schedules import crontab

from app.config import get_settings

settings = get_settings()
celery_app = Celery(
    "alpha_trader",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.tasks"],
)
celery_app.conf.update(
    timezone="Asia/Shanghai",
    enable_utc=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    beat_schedule={
        "定时扫描全市场机会": {
            "task": "alpha_trader.scan_market",
            "schedule": timedelta(seconds=settings.market_scan_interval_seconds),
        },
        "生成每日真实交易复盘": {
            "task": "alpha_trader.daily_review",
            "schedule": crontab(hour=settings.daily_review_hour, minute=settings.daily_review_minute),
        },
        "刷新活动持仓管理建议": {
            "task": "alpha_trader.monitor_positions",
            "schedule": timedelta(seconds=60),
        },
    },
)
