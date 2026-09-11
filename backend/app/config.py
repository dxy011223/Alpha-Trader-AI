from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用配置；所有敏感值仅从环境变量读取。"""

    app_name: str = "Alpha Trader AI"
    environment: str = "development"
    database_url: str = "sqlite:///./alpha_trader.db"
    redis_url: str = "redis://localhost:6379/0"
    market_api_key: str | None = None
    news_api_key: str | None = None
    ai_api_key: str | None = None
    owner_api_token: str | None = None
    credential_encryption_key: str | None = None
    ai_model: str = "gpt-5-mini"
    ai_base_url: str = "https://api.openai.com/v1"
    ai_timeout_seconds: float = 20.0
    ai_requests_per_minute: int = 12
    ai_requests_per_day: int = 300
    ai_max_concurrency: int = 2
    news_refresh_seconds: int = 300
    market_scan_interval_seconds: int = 300
    market_scan_cache_seconds: int = 360
    daily_review_hour: int = 0
    daily_review_minute: int = 10
    max_active_executions: int = 3

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
