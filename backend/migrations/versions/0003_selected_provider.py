"""Persist the selected LLM provider."""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "app_settings", sa.Column("provider", sa.String(), nullable=False, server_default="")
    )


def downgrade():
    with op.batch_alter_table("app_settings") as batch:
        batch.drop_column("provider")
