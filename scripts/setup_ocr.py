"""Install the two local OCR language files; runtime never downloads book data/models."""

from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def main():
    target = ROOT / ".cache" / "tessdata"
    target.mkdir(parents=True, exist_ok=True)
    for language in ("kor", "eng"):
        path = target / f"{language}.traineddata"
        if path.exists():
            continue
        url = f"https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/{path.name}"
        temporary = path.with_suffix(".tmp")
        try:
            with urlopen(url, timeout=60) as response:
                temporary.write_bytes(response.read())
            temporary.replace(path)
            print(f"Installed OCR language: {language}")
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
