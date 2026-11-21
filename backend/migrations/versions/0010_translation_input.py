"""How page translation reads the page: rendered image, automatic, or extracted text."""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "app_settings",
        sa.Column("translation_input", sa.String(), nullable=False, server_default="image"),
    )


def downgrade():
    with op.batch_alter_table("app_settings") as batch:
        batch.drop_column("translation_input")
