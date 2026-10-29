"""Manage a background production server using only the Python standard library."""

import argparse
import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".cache" / "servers"


def identity(pid):
    """Match start time and command as well as PID, to avoid stopping a reused PID."""
    result = subprocess.run(
        [
            "/bin/ps",
            "-ww",
            "-p",
            str(pid),
            "-o",
            "stat=",
            "-o",
            "lstart=",
            "-o",
            "args=",
        ],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "LC_ALL": "C"},
    )
    if result.returncode:
        if result.stderr.strip():
            raise RuntimeError(
                "프로세스 정보를 확인할 수 없습니다. 실행 권한을 확인해 주세요."
            )
        return None
    parts = result.stdout.strip().split(maxsplit=1)
    if len(parts) != 2 or "Z" in parts[0]:
        return None
    fields = parts[1].split(maxsplit=6)
    if len(fields) != 7:
        return None
    # macOS may expand argv[0] from the venv symlink to Python.app during startup.
    # The start timestamp and remaining arguments stay stable across that transition.
    return " ".join(fields[:5]) + " " + fields[6]


def read_record(path):
    if not path.exists():
        return None
    try:
        record = json.loads(path.read_text())
        pid = record["pid"]
        if (
            not isinstance(pid, int)
            or pid <= 1
            or not isinstance(record["identity"], str)
        ):
            raise ValueError("Invalid PID record")
        if identity(pid) == record["identity"]:
            return record
    except (ValueError, KeyError, TypeError):
        raise RuntimeError(f"PID 기록을 읽을 수 없습니다: {path}") from None
    # A stale record is not permission to signal any other process.
    path.unlink(missing_ok=True)
    return None


def healthy(record):
    host = record["host"]
    if host == "0.0.0.0":
        host = "127.0.0.1"
    if host in ("::", "::1"):
        host = "[::1]"
    request = urllib.request.Request(f"http://{host}:{record['port']}/api/health")
    try:
        # A local health check should not be routed through HTTP_PROXY.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=1) as response:
            return json.load(response).get("status") == "ok"
    except (OSError, ValueError, urllib.error.URLError):
        return False


@contextmanager
def locked(port):
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with (RUNTIME / f"{port}.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(
                "다른 서버 관리 명령이 실행 중입니다. 잠시 후 다시 시도해 주세요."
            ) from None
        yield


def stop(path):
    record = read_record(path)
    if not record:
        print("서버가 이미 중지되어 있습니다.")
        return
    pid = record["pid"]
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        path.unlink(missing_ok=True)
        print("서버가 이미 종료되었습니다.")
        return
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if identity(pid) != record["identity"]:
            path.unlink(missing_ok=True)
            print(f"서버 중지 완료 (PID {pid})")
            return
        time.sleep(0.2)
    raise RuntimeError(
        "서버가 아직 종료 중입니다. 잠시 후 status 또는 stop을 다시 실행해 주세요."
    )


def start(args, path, log):
    existing = read_record(path)
    if existing:
        print(f"서버가 이미 실행 중입니다 (PID {existing['pid']}, 포트 {args.port}).")
        return
    python = ROOT / "backend/.venv/bin/python"
    if not python.exists():
        raise RuntimeError("먼저 make install을 실행해 주세요.")
    if not (ROOT / "frontend/dist/index.html").exists():
        raise RuntimeError("먼저 make build를 실행해 주세요.")
    try:
        addresses = socket.getaddrinfo(args.host, args.port, type=socket.SOCK_STREAM)
        family, kind, protocol, _, address = addresses[0]
        with socket.socket(family, kind, protocol) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(address)
    except OSError:
        raise RuntimeError(
            f"{args.host}:{args.port} 포트를 사용할 수 없습니다. 다른 서버는 종료하지 않았습니다."
        ) from None
    with log.open("ab") as output:
        process = subprocess.Popen(
            [
                str(python),
                "-m",
                "uvicorn",
                "app.asgi:app",
                "--app-dir",
                str(ROOT / "backend"),
                "--host",
                args.host,
                "--port",
                str(args.port),
                "--timeout-graceful-shutdown",
                "10",
            ],
            cwd=ROOT / "backend",
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    try:
        record = {
            "pid": process.pid,
            "identity": identity(process.pid),
            "host": args.host,
            "port": args.port,
        }
        if not record["identity"]:
            raise RuntimeError(f"서버를 시작하지 못했습니다. 로그: {log}")
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(record))
        temporary.replace(path)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"서버가 시작 중 종료되었습니다. 로그: {log}")
            if healthy(record) and process.poll() is None:
                display = "127.0.0.1" if args.host == "0.0.0.0" else args.host
                if ":" in display:
                    display = f"[{display}]"
                print(
                    f"서버 시작 완료 (PID {process.pid})\nhttp://{display}:{args.port}\n로그: {log}"
                )
                return
            time.sleep(0.2)
        raise RuntimeError(f"서버 준비 시간이 초과되었습니다. 로그: {log}")
    except BaseException:
        # Popen is our own child; never terminate a process discovered by its port.
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                raise RuntimeError(f"서버가 종료 중입니다. 상태 기록: {path}") from None
        path.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description="Textbook Studio 백그라운드 서버 관리")
    parser.add_argument(
        "action", choices=["start", "stop", "restart", "status", "logs"]
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("포트는 1~65535 범위여야 합니다.")
    path, log = RUNTIME / f"{args.port}.json", RUNTIME / f"{args.port}.log"
    if args.action == "logs":
        if not log.exists():
            print("아직 서버 로그가 없습니다.")
            return 0
        try:
            return subprocess.call(["tail", "-n", "80", "-f", str(log)])
        except KeyboardInterrupt:
            return 0
    with locked(args.port):
        if args.action in ("stop", "restart"):
            stop(path)
        if args.action in ("start", "restart"):
            start(args, path, log)
        if args.action == "status":
            record = read_record(path)
            if not record:
                print("서버 중지 상태")
                return 1
            ready = healthy(record)
            print(
                f"서버 {'실행 중' if ready else '프로세스 실행 중 · 응답 확인 필요'} (PID {record['pid']}, 포트 {args.port})"
            )
            print(f"로그: {log}")
            return 0 if ready else 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
