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

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()

