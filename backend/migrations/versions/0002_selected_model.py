"""Persist the selected tutoring model without changing existing reader data."""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "app_settings", sa.Column("model", sa.String(), nullable=False, server_default="")
    )


def downgrade():
    with op.batch_alter_table("app_settings") as batch:
        batch.drop_column("model")
