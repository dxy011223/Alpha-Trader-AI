from app.celery_app import celery_app


def test_periodic_market_scan_and_daily_review_are_configured():
    schedule = celery_app.conf.beat_schedule

    assert schedule["定时扫描全市场机会"]["task"] == "alpha_trader.scan_market"
    assert schedule["生成每日真实交易复盘"]["task"] == "alpha_trader.daily_review"
    assert celery_app.conf.timezone == "Asia/Shanghai"
