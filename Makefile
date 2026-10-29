.PHONY: install dev build serve test test-live

install:
	cd backend && uv sync --locked --cache-dir ../.cache/uv
	cd frontend && npm ci --cache ../.cache/npm

dev:
	python3 scripts/dev.py

build:
	cd frontend && npm run build

serve:
	cd backend && .venv/bin/python -m uvicorn app.asgi:app --host 127.0.0.1 --port 8000

test:
	cd backend && .venv/bin/ruff check app migrations tests && .venv/bin/pytest -q
	cd frontend && npm test && npm run build

test-live:
	backend/.venv/bin/python scripts/verify_live.py
