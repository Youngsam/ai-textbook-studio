"""Start the installed backend and Vite together. Ctrl+C stops both process groups."""

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--api-port", default=8000, type=int)
    parser.add_argument("--web-port", default=5173, type=int)
    args = parser.parse_args()
    python = ROOT / "backend/.venv/bin/python"
    vite = ROOT / "frontend/node_modules/.bin/vite"
    if not python.exists() or not vite.exists():
        sys.exit("먼저 make install을 실행해 주세요.")
    subprocess.run(
        ["node", "scripts/pdf-assets.mjs"], cwd=ROOT / "frontend", check=True
    )
    processes = []
    exit_code = 0
    try:
        processes.append(
            subprocess.Popen(
                [
                    str(python),
                    "-m",
                    "uvicorn",
                    "app.asgi:app",
                    "--host",
                    args.host,
                    "--port",
                    str(args.api_port),
                ],
                cwd=ROOT / "backend",
                start_new_session=True,
            )
        )
        processes.append(
            subprocess.Popen(
                [
                    str(vite),
                    "--host",
                    args.host,
                    "--port",
                    str(args.web_port),
                    "--strictPort",
                ],
                cwd=ROOT / "frontend",
                env={
                    **os.environ,
                    "STUDIO_API_URL": f"http://127.0.0.1:{args.api_port}",
                },
                start_new_session=True,
            )
        )
        print(
            f"\nTextbook Studio: http://127.0.0.1:{args.web_port} · 종료: Ctrl+C\n",
            flush=True,
        )
        while all(process.poll() is None for process in processes):
            time.sleep(0.3)
        exit_code = (
            next(
                (
                    process.returncode
                    for process in processes
                    if process.returncode is not None
                ),
                1,
            )
            or 1
        )
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
