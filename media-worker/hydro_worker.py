"""Hydro mode for the ICPC reactions-generator media machine."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import os
import re
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import quote

import requests

if __package__:
    from .hydro_connection import Connection, load_connection, safe_error
    from .hydro_render import render
else:
    from hydro_connection import Connection, load_connection, safe_error
    from hydro_render import render

VERSION = "1.23.1"
SAFE_ID = re.compile(r"[a-zA-Z0-9_-]{1,100}")


def partition(key, count):
    return int.from_bytes(hashlib.sha256(key.encode()).digest(), "big") % count


def request(method, url, *, source=None, attempts=4, secret="", **kwargs):
    headers = {"X-Hydro-Reaction-Template": "icpc-v1"}
    if secret:
        headers["Authorization"] = "Bearer " + secret
    kwargs.update(headers=headers, allow_redirects=False)
    for index in range(attempts):
        try:
            if source:
                headers["Content-Type"] = "video/mp4"
                with source.open("rb") as content:
                    response = requests.request(
                        method,
                        url,
                        data=content,
                        timeout=(10, 180),
                        **kwargs,
                    )
            else:
                response = requests.request(method, url, timeout=(10, 45), **kwargs)
            if 300 <= response.status_code < 400:
                response.close()
                raise requests.RequestException(
                    "Unexpected redirection from the media API"
                )
            if (
                response.status_code < 500
                and response.status_code != 429
                or index + 1 == attempts
            ):
                response.raise_for_status()
                return response
            response.close()
        except (requests.ConnectionError, requests.Timeout):
            if index + 1 == attempts:
                raise
        time.sleep(2**index)


def process_partition(
    base,
    out,
    worker_id,
    total_workers,
    encoder="cpu",
    poll=3,
    once=False,
    with_sound=True,
    shutdown=None,
):
    if not (total_workers > 0 and 0 <= worker_id < total_workers and poll > 0):
        raise ValueError("Invalid partition or poll interval")
    connection = base if isinstance(base, Connection) else load_connection(base)
    base = connection.base
    namespace = hashlib.sha256(base.encode()).hexdigest()[:16]
    folder = Path(out) / namespace
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{socket.gethostname()}-{worker_id}"
    state = {
        "name": name,
        "version": VERSION,
        "template": "icpc-v1",
        "partition": f"{worker_id}/{total_workers}",
        "current": None,
        "queue": 0,
    }
    shutdown = shutdown or threading.Event()
    stop = threading.Event()
    endpoint = base + "/reactions"

    def api(method, url, **kwargs):
        return request(method, url, secret=connection.token, **kwargs)

    def announce():
        api("POST", endpoint + "/worker", json=state.copy(), attempts=1)

    def heartbeats():
        while not stop.wait(15):
            try:
                announce()
            except requests.RequestException as exc:
                print(safe_error(exc, connection), file=sys.stderr, flush=True)

    thread = threading.Thread(target=heartbeats, daemon=True)
    thread.start()
    try:
        while not shutdown.is_set():
            try:
                catalog = api("GET", endpoint + "/layouts.json").json()
                layouts = {
                    str(v.get("id", v.get("_id"))): v for v in catalog["layouts"]
                }
                jobs = [
                    j
                    for j in catalog["tasks"]
                    if partition(str(j["runId"]), total_workers) == worker_id
                ]
                jobs.sort(key=lambda j: j["priority"])
                state["queue"] = len(jobs)
                announce()
                for job in jobs:
                    rid, lid = str(job["runId"]), str(job["layoutId"])
                    if not SAFE_ID.fullmatch(rid) or not SAFE_ID.fullmatch(lid):
                        raise ValueError("Invalid task ID")
                    generation = int(job["generation"])
                    key = f"{rid}-{lid}-{generation}"
                    error = folder / (key + ".err")
                    marker = folder / (key + ".ready")
                    done = folder / (key + ".sent")
                    if error.exists() or done.exists():
                        continue
                    state["current"] = {
                        "runId": rid,
                        "layoutId": lid,
                        "generation": generation,
                    }
                    result = endpoint + f"/results/{rid}/{lid}"
                    output = folder / (key + ".mp4")
                    try:
                        announce()
                        if not (output.exists() and marker.exists()):
                            detail = api(
                                "GET", endpoint + "/fullRuns/" + quote(rid)
                            ).json()
                            layout = job.get("layout") or layouts[lid]
                            sound_name = (
                                "success.mp3"
                                if detail.get("result", {})
                                .get("verdict", {})
                                .get("isAccepted")
                                else "fail.mp3"
                            )
                            with tempfile.TemporaryDirectory(dir=folder) as temp:
                                work = Path(temp)
                                duration = render(
                                    base,
                                    {**job, "layout": layout},
                                    detail,
                                    work,
                                    work / "out.mp4",
                                    encoder,
                                    secret=connection.token,
                                    sound=Path("example") / sound_name
                                    if with_sound
                                    else None,
                                )
                                os.replace(work / "out.mp4", output)
                            marker.write_text(str(duration))
                        api(
                            "PUT",
                            result,
                            source=output,
                            params={
                                "generation": generation,
                                "durationMs": int(marker.read_text()),
                                "codec": "h264",
                            },
                        )
                        done.touch()
                    except requests.RequestException as exc:
                        # The encoded file stays available for a retry after an upload/network interruption.
                        print(safe_error(exc, connection), file=sys.stderr, flush=True)
                        if once:
                            raise
                    except (RuntimeError, ValueError, KeyError, OSError) as exc:
                        message = safe_error(exc, connection)
                        api(
                            "POST",
                            result + "/error",
                            json={"generation": generation, "error": message},
                        )
                        error.write_text(message)
                        if once:
                            raise
                    finally:
                        state["current"] = None
                        state["queue"] = max(0, state["queue"] - 1)
                    if not once:
                        break  # Rediscover priority after each render.
                if once:
                    announce()
                    return
            except (requests.RequestException, ValueError) as exc:
                if once:
                    raise
                print(safe_error(exc, connection), file=sys.stderr, flush=True)
            shutdown.wait(poll)
    finally:
        stop.set()
        thread.join(timeout=1)


def continuous(
    base,
    output_directory,
    total_workers,
    worker_id,
    hardware,
    poll_interval,
    sound=True,
    once=False,
):
    connection = load_connection(base)
    if not 1 <= total_workers <= 128 or (
        worker_id is not None and not 0 <= worker_id < total_workers
    ):
        raise ValueError("Invalid worker count or worker ID")
    parts = list(range(total_workers)) if worker_id is None else [worker_id]
    shutdown = threading.Event()
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(parts)) as pool:
        futures = [
            pool.submit(
                process_partition,
                connection,
                output_directory,
                i,
                total_workers,
                hardware,
                poll_interval,
                once,
                sound,
                shutdown,
            )
            for i in parts
        ]
        try:
            for future in concurrent.futures.as_completed(futures):
                future.result()
        except Exception as exc:
            raise RuntimeError(safe_error(exc, connection)) from None
        finally:
            shutdown.set()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["all"])
    parser.add_argument(
        "url",
        nargs="?",
        help="Legacy contest URL; defaults to the media connection in .env",
    )
    parser.add_argument("--hydro-upload", action="store_true", required=True)
    parser.add_argument("--total-workers", type=int, default=1)
    parser.add_argument("--worker-id", type=int)
    parser.add_argument(
        "--hardware",
        choices=["cpu", "nvidia", "apple", "qsv", "nvidia_full", "vaapi"],
        default="cpu",
    )
    parser.add_argument("--output-directory", default="out")
    parser.add_argument("--once", action="store_true")
    opts = parser.parse_args()
    continuous(
        opts.url,
        opts.output_directory,
        opts.total_workers,
        opts.worker_id,
        opts.hardware,
        3,
        once=opts.once,
    )
