"""Persist backup destination."""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "app_settings", sa.Column("backup_path", sa.String(), nullable=False, server_default="")
    )


def downgrade():
    with op.batch_alter_table("app_settings") as batch:
        batch.drop_column("backup_path")
