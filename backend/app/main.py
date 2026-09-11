import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import router
from app.config import get_settings
from app.database import Base, engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.environment.lower() == "production" and len((settings.owner_api_token or "").strip()) < 32:
        raise RuntimeError("生产环境必须配置至少 32 位的 OWNER_API_TOKEN")
    if settings.environment.lower() == "production":
        from alembic import command
        from alembic.config import Config

        migration_config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
        command.upgrade(migration_config, "head")
        logger.info("数据库迁移已升级到最新版本")
    else:
        Base.metadata.create_all(bind=engine)
    logger.info("数据库模型初始化完成")
    yield
    logger.info("Alpha Trader AI 服务已停止")


settings = get_settings()
app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5175",
        "http://127.0.0.1:5175",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)


@app.get("/health", tags=["system"], summary="健康检查")
def health_check() -> dict[str, str]:
    return {"status": "ok", "service": settings.app_name}
