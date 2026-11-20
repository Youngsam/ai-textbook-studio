"""Figure regions cropped from the original page for translated views."""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "page_translations",
        sa.Column("figures", sa.JSON(), nullable=False, server_default="[]"),
    )


def downgrade():
    with op.batch_alter_table("page_translations") as batch:
        batch.drop_column("figures")
