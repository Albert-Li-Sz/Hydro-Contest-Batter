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
from urllib.parse import quote, urlsplit

import requests

if __package__:
    from .hydro_render import render
else:
    from hydro_render import render

VERSION = "1.21.0"
SAFE_ID = re.compile(r"[a-zA-Z0-9_-]{1,100}")


def partition(key, count):
    return int.from_bytes(hashlib.sha256(key.encode()).digest(), "big") % count


def request(method, url, *, source=None, attempts=4, **kwargs):
    for index in range(attempts):
        try:
            if source:
                with source.open("rb") as content:
                    response = requests.request(
                        method,
                        url,
                        data=content,
                        headers={"Content-Type": "video/mp4"},
                        timeout=(10, 180),
                        **kwargs,
                    )
            else:
                response = requests.request(method, url, timeout=(10, 45), **kwargs)
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


def safe_error(exc, base):
    message = (
        str(exc)
        .replace(base, "<contest>")
        .replace(urlsplit(base).path.rsplit("/", 1)[-1], "<token>")
    )
    return re.sub(r"([?&](?:sig|signature|token)=)[^&\s]+", r"\1<redacted>", message)[
        -1800:
    ]


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
    base = base.rstrip("/")
    namespace = hashlib.sha256(base.encode()).hexdigest()[:16]
    folder = Path(out) / namespace
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{socket.gethostname()}-{worker_id}"
    state = {
        "name": name,
        "version": VERSION,
        "partition": f"{worker_id}/{total_workers}",
        "current": None,
        "queue": 0,
    }
    shutdown = shutdown or threading.Event()
    stop = threading.Event()
    endpoint = base + "/reactions"

    def announce():
        request("POST", endpoint + "/worker", json=state.copy(), attempts=1)

    def heartbeats():
        while not stop.wait(15):
            try:
                announce()
            except requests.RequestException as exc:
                print(safe_error(exc, base), file=sys.stderr, flush=True)

    thread = threading.Thread(target=heartbeats, daemon=True)
    thread.start()
    try:
        while not shutdown.is_set():
            try:
                catalog = request("GET", endpoint + "/layouts.json").json()
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
                    announce()
                    result = endpoint + f"/results/{rid}/{lid}"
                    output = folder / (key + ".mp4")
                    try:
                        if not (output.exists() and marker.exists()):
                            detail = request(
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
                                    sound=Path("example") / sound_name
                                    if with_sound
                                    else None,
                                )
                                os.replace(work / "out.mp4", output)
                            marker.write_text(str(duration))
                        request(
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
                        print(safe_error(exc, base), file=sys.stderr, flush=True)
                        if once:
                            raise
                    except (RuntimeError, ValueError, KeyError, OSError) as exc:
                        message = safe_error(exc, base)
                        request(
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
                print(safe_error(exc, base), file=sys.stderr, flush=True)
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
                base,
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
        finally:
            shutdown.set()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["all"])
    parser.add_argument("url")
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
