import sys

import pytest

from app.backup import copy_pdf


def test_copy_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr("app.backup.sys.platform", "linux")
    source, output = tmp_path / "source.pdf", tmp_path / "copy.pdf"
    source.write_bytes(b"original")
    copy_pdf(source, output)
    source.write_bytes(b"changed")
    assert output.read_bytes() == b"original"


def test_unsupported_clone_falls_back(tmp_path, monkeypatch):
    class Unsupported:
        def __call__(self, *args):
            return -1

    class Library:
        clonefile = Unsupported()

    monkeypatch.setattr("app.backup.sys.platform", "darwin")
    monkeypatch.setattr("app.backup.ctypes.CDLL", lambda *a, **kw: Library())
    source, output = tmp_path / "source.pdf", tmp_path / "copy.pdf"
    source.write_bytes(b"original")
    copy_pdf(source, output)
    assert output.read_bytes() == b"original"


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS clonefile integration")
def test_clone_is_independent_and_survives_source_removal(tmp_path, monkeypatch):
    source, output = tmp_path / "source.pdf", tmp_path / "copy.pdf"
    source.write_bytes(b"original" * 8192)

    def no_copy(*args):
        pytest.fail("Expected native clone on the local test filesystem")

    monkeypatch.setattr("app.backup.shutil.copyfile", no_copy)
    copy_pdf(source, output)
    assert source.stat().st_ino != output.stat().st_ino
    with source.open("r+b") as stream:
        stream.write(b"modified")
    assert output.read_bytes() == b"original" * 8192
    with output.open("r+b") as stream:
        stream.write(b"snapshot")
    assert source.read_bytes().startswith(b"modified")
    source.unlink()
    assert output.read_bytes().startswith(b"snapshot")
