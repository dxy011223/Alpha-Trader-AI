"""初始化 Alpha Trader AI 持久化结构。"""

from alembic import op

from app.database import Base
from app import models  # noqa: F401，确保 metadata 完整。


revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 对已经由旧版 create_all 创建的数据库保持幂等，并开始记录迁移版本。
    Base.metadata.create_all(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    # 初始迁移不自动删除交易与复盘数据，回退需由管理员显式处理。
    pass
