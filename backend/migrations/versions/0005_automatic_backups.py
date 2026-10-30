"""Automatic backup preferences and persistent status."""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "app_settings",
        sa.Column("backup_auto", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "app_settings", sa.Column("backup_state", sa.JSON(), nullable=False, server_default="{}")
    )


def downgrade():
    with op.batch_alter_table("app_settings") as batch:
        batch.drop_column("backup_state")
        batch.drop_column("backup_auto")
