"""Cached Korean translations of individual PDF pages."""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "page_translations",
        sa.Column(
            "book_id",
            sa.String(),
            sa.ForeignKey("books.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("page", sa.Integer(), primary_key=True),
        sa.Column("content", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("truncated", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.CheckConstraint("page >= 1"),
    )


def downgrade():
    op.drop_table("page_translations")
