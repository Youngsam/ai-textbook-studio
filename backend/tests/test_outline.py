from pathlib import Path

import pymupdf
import pytest

from app.outline import detect_outline, entries_on_page, read_rows

TESSDATA = Path(__file__).resolve().parents[2] / ".cache" / "tessdata"


def contents_page(document, heading="Contents", start=1, columns=False, korean=False):
    page = document.new_page()
    if heading:
        page.insert_text((50, 55), heading, fontname="korea" if korean else "helv", fontsize=20)
    titles = ["1 Introduction", "1.1 Vector spaces", "2 Linear transformations"]
    if korean:
        titles = ["1 기초 개념", "1.1 벡터 공간", "2 선형 변환"]
    for i, title in enumerate(titles):
        y = 120 + i * 35
        page.insert_text((50, y), title, fontname="korea" if korean else "helv", fontsize=13)
        page.insert_text((265 if columns else 500, y), str(start + i * 2), fontsize=13)
        if columns:
            page.insert_text((330, y), f"Advanced topic {i + 1}", fontsize=13)
            page.insert_text((550, y), str(start + 6 + i * 2), fontsize=13)
    return page


def document_with_contents(scan=False, footers=True, korean=False):
    document = pymupdf.open()
    page = contents_page(document, heading="목차" if korean else "Contents", korean=korean)
    for i in range(10):
        page = document.new_page()
        page.insert_text(
            (50, 100), "This chapter explains vector spaces and linear transformations."
        )
        if footers:
            page.insert_text((290, 810), str(i + 1))
    if scan:
        scanned = pymupdf.open()
        for page in document:
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2, 2))
            target = scanned.new_page(width=page.rect.width, height=page.rect.height)
            target.insert_image(target.rect, pixmap=pixmap)
        document.close()
        document = scanned
    return document


def detect(document, **kwargs):
    return detect_outline(document, tessdata=str(TESSDATA), **kwargs)


def test_text_contents_hierarchy_and_physical_page_offset():
    with document_with_contents() as document:
        result = detect(document)
    assert result["source"] == "text"
    assert result["mapping_verified"] is True
    assert result["page_offset"] == 1
    assert [i["page"] for i in result["items"]] == [2, 4, 6]
    assert [i["level"] for i in result["items"]] == [1, 2, 1]


def test_unknown_mapping_does_not_guess_navigation():
    with document_with_contents(footers=False) as document:
        result = detect(document)
    assert result["mapping_verified"] is False
    assert [i["page"] for i in result["items"]] == [None] * 3


@pytest.mark.parametrize("korean", [False, True])
def test_real_image_only_ocr(korean):
    if not all((TESSDATA / f"{lang}.traineddata").exists() for lang in ("eng", "kor")):
        pytest.skip("Run make install-ocr for actual OCR integration tests")
    with document_with_contents(scan=True, korean=korean) as document:
        assert document[0].get_text() == ""
        result = detect(document)
    assert result["source"] == "ocr"
    assert [i["printed_page"] for i in result["items"]] == [1, 3, 5]
    assert [i["page"] for i in result["items"]] == [2, 4, 6]
    assert (
        "기초" in result["items"][0]["title"]
        if korean
        else "Introduction" in result["items"][0]["title"]
    )


@pytest.mark.parametrize(
    "heading", ["List of Figures", "List of Tables", "그림 목차", "표 목차", "Experimental results"]
)
def test_figure_table_lists_and_body_tables_are_not_contents(heading):
    with pymupdf.open() as document:
        page = contents_page(document, heading=heading, korean=bool("목차" in heading))
        rows, _ = read_rows(page, "kor+eng", str(TESSDATA))
        assert entries_on_page(rows, page.rect.width, page.rect.height) == []


def test_two_columns_and_continuation():
    with pymupdf.open() as document:
        page = contents_page(document, columns=True)
        rows, _ = read_rows(page, "eng", str(TESSDATA))
        result = entries_on_page(rows, page.rect.width, page.rect.height)
        assert [i["printed_page"] for i in result] == [1, 3, 5, 7, 9, 11]
        page = contents_page(document, heading="", start=13)
        rows, _ = read_rows(page, "eng", str(TESSDATA))
        assert entries_on_page(rows, page.rect.width, page.rect.height) == []
        assert len(entries_on_page(rows, page.rect.width, page.rect.height, continuation=True)) == 3


def test_nonmonotonic_numbers_and_captions_rejected():
    with pymupdf.open() as document:
        page = contents_page(document)
        page.insert_text((50, 240), "List of Figures", fontsize=16)
        for i in range(3):
            page.insert_text((50, 280 + i * 30), f"Figure {i + 1} Illustration")
            page.insert_text((500, 280 + i * 30), str(i + 1))
        rows, _ = read_rows(page, "eng", str(TESSDATA))
        assert len(entries_on_page(rows, page.rect.width, page.rect.height)) == 3
        page = document.new_page()
        page.insert_text((50, 55), "Contents", fontsize=20)
        for i, n in enumerate([10, 2, 8]):
            page.insert_text((50, 120 + i * 35), f"Chapter title {i}")
            page.insert_text((500, 120 + i * 35), str(n))
        rows, _ = read_rows(page, "eng", str(TESSDATA))
        assert entries_on_page(rows, page.rect.width, page.rect.height) == []


def test_missing_ocr_data_has_actionable_status():
    with document_with_contents(scan=True) as document:
        result = detect_outline(document, tessdata="/nonexistent/tessdata")
    assert result == {"items": [], "status": "ocr_unavailable"}


def test_bookmarks_take_priority_without_ocr(monkeypatch):
    with document_with_contents(scan=True) as document:
        document.set_toc([[1, "Author bookmark", 7]])
        monkeypatch.setattr("app.outline.read_rows", lambda *args: pytest.fail("unneeded OCR"))
        assert detect(document) == {"items": [{"level": 1, "title": "Author bookmark", "page": 7}]}


def test_dense_numeric_table_under_contents_heading_is_rejected():
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((50, 55), "Contents", fontsize=20)
        for i in range(5):
            page.insert_text((50, 120 + i * 35), f"Sample {i + 1}")
            for x, value in [(200, 10), (300, 20), (400, 30), (500, 40)]:
                page.insert_text((x, 120 + i * 35), str(value + i))
        rows, _ = read_rows(page, "eng", str(TESSDATA))
        assert entries_on_page(rows, page.rect.width, page.rect.height) == []


def test_joined_dot_leaders_are_parsed():
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((50, 55), "Contents", fontsize=20)
        for i in range(3):
            page.insert_text((50, 120 + i * 35), f"Chapter{i + 1}................{i + 1}")
        rows, _ = read_rows(page, "eng", str(TESSDATA))
        result = entries_on_page(rows, page.rect.width, page.rect.height)
        assert [i["printed_page"] for i in result] == [1, 2, 3]
        assert result[0]["title"] == "Chapter1"


def test_two_numeric_columns_are_not_contents():
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((50, 55), "Contents", fontsize=20)
        for i in range(4):
            page.insert_text((50, 120 + i * 35), f"Experiment {i}")
            page.insert_text((300, 120 + i * 35), str(10 + i))
            page.insert_text((500, 120 + i * 35), str(20 + i))
        rows, _ = read_rows(page, "eng", str(TESSDATA))
        assert entries_on_page(rows, page.rect.width, page.rect.height) == []


def test_excerpt_can_have_negative_page_offset():
    with pymupdf.open() as document:
        contents_page(document, start=101)
        for i in range(6):
            page = document.new_page()
            page.insert_text((50, 100), "A chapter about vectors and transformations.")
            page.insert_text((290, 810), str(101 + i))
        result = detect(document)
        assert result["page_offset"] == -99
        assert [i["page"] for i in result["items"]] == [2, 4, 6]


@pytest.mark.parametrize("heading", ["6 Contents", "Contents 9", "1() Contents"])
def test_contents_running_header_with_page_number(heading):
    with pymupdf.open() as document:
        page = contents_page(document, heading=heading)
        rows, _ = read_rows(page, "eng", str(TESSDATA))
        assert len(entries_on_page(rows, page.rect.width, page.rect.height)) == 3


def test_boundary_number_error_does_not_drop_following_contents_page():
    with pymupdf.open() as document:
        contents_page(document, start=1)
        contents_page(document, heading="Contents 2", start=4)
        result = detect(document)
        assert [e["printed_page"] for e in result["items"]] == [1, 3, 5, 4, 6, 8]


def test_corrupt_existing_ocr_number_coordinates_are_repaired():
    if not (TESSDATA / "eng.traineddata").exists():
        pytest.skip("Run make install-ocr for actual OCR integration tests")
    with pymupdf.open() as document:
        page = contents_page(document)
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2, 2))
        document.delete_page(0)
        page = document.new_page()
        page.insert_image(page.rect, pixmap=pixmap)
        page.insert_text((50, 55), "Contents 4", fontsize=20, render_mode=3)
        for i, title in enumerate(
            ["1 Introduction", "1.1 Vector spaces", "2 Linear transformations"]
        ):
            page.insert_text((50, 120 + i * 35), title, fontsize=13, render_mode=3)
            # A damaged text layer collapses every printed number onto the same line.
            page.insert_text((500, 75), str(i * 2 + 1), fontsize=13, render_mode=3)
        result = detect(document)
        assert [e["printed_page"] for e in result["items"]] == [1, 3, 5]
        assert result["items"][1]["title"] == "1.1 Vector spaces"
        assert result["source"] == "ocr"
