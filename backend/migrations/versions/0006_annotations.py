"""Persistent text highlights and notes in normalized page coordinates."""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "annotations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "book_id", sa.String(), sa.ForeignKey("books.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("page", sa.Integer(), nullable=False),
        sa.Column("selected_text", sa.String(), nullable=False),
        sa.Column("rects", sa.JSON(), nullable=False),
        sa.Column("color", sa.String(), nullable=False),
        sa.Column("note", sa.String(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
        sa.CheckConstraint("page >= 1"),
        sa.CheckConstraint("color IN ('yellow', 'green', 'blue', 'pink')"),
    )
    op.create_index("annotation_book_page", "annotations", ["book_id", "page"])


def downgrade():
    op.drop_table("annotations")
