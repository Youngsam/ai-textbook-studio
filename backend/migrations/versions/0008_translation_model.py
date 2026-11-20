"""Optional provider and model dedicated to page translation."""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    # Blank values mean "use the explanation model".
    op.add_column(
        "app_settings",
        sa.Column("translation_provider", sa.String(), nullable=False, server_default=""),
    )
    op.add_column(
        "app_settings",
        sa.Column("translation_model", sa.String(), nullable=False, server_default=""),
    )


def downgrade():
    with op.batch_alter_table("app_settings") as batch:
        batch.drop_column("translation_model")
        batch.drop_column("translation_provider")
