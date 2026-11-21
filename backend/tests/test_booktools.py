from app.booktools import format_outline, read_pages, search_book

PAGES = ["Intro to vectors", "Eigenvalue definition: Av = λv", "Example using eigenvalue"]


def test_read_pages_clamps_range_and_respects_budget():
    text, read = read_pages(PAGES, 0, 99, 10_000)
    assert read == [1, 2, 3] and '<page number="2">' in text
    text, read = read_pages(PAGES, 2, 3, 40)
    assert read == [2] and "생략" in text
    assert read_pages(PAGES, 3, 3, 0)[1] == []
    assert read_pages(PAGES, 5, 6, 10_000)[1] == []


def test_search_ranks_distinct_terms_and_reports_misses():
    result = search_book(PAGES, "Eigenvalue definition")
    assert result.splitlines()[0].startswith("- p.2:")
    assert "p.3" in result and "p.1" not in result
    assert "찾지 못했습니다" in search_book(PAGES, "tensor")


def test_outline_lists_known_and_printed_pages():
    text = format_outline(
        [
            {"level": 1, "title": "1장 벡터", "page": 3},
            {"level": 2, "title": "1.1 내적", "printed_page": 4, "page": None},
            {"level": 1, "title": "번호 없음"},
        ],
        120,
    )
    assert 'total_pdf_pages="120"' in text
    assert "- 1장 벡터 (p.3)" in text and "  - 1.1 내적 (인쇄 4쪽)" in text
    assert "번호 없음" not in text
