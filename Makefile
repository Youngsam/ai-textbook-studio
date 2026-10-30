.PHONY: install install-ocr dev build serve up down restart status logs test test-live

install:
	cd backend && uv sync --locked --cache-dir ../.cache/uv
	cd frontend && npm ci --cache ../.cache/npm
	$(MAKE) install-ocr

install-ocr:
	python3 scripts/setup_ocr.py

dev:
	python3 scripts/dev.py

build:
	cd frontend && npm run build

serve:
	cd backend && .venv/bin/python -m uvicorn app.asgi:app --host 127.0.0.1 --port 8000

up:
	python3 scripts/server.py start

down:
	python3 scripts/server.py stop

restart:
	python3 scripts/server.py restart

status:
	python3 scripts/server.py status

logs:
	python3 scripts/server.py logs

test:
	cd backend && .venv/bin/ruff check app migrations tests && .venv/bin/pytest -q
	cd frontend && npm test && npm run build

test-live:
	backend/.venv/bin/python scripts/verify_live.py
