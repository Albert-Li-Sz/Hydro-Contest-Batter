"""Compose a Hydro layout in contest time. Only the media machine runs FFmpeg."""

from __future__ import annotations

import concurrent.futures
import json
import math
import re
import subprocess
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import requests
from PIL import Image, ImageDraw, ImageFont

FPS = 25
FONT = Path(__file__).resolve().parent / "fonts/NotoSansSC-VF.ttf"


if not FONT.exists():
    FONT = (
        Path(__file__).resolve().parents[1]
        / "resolver/public/assets/font/NotoSansSC-VF.ttf"
    )


def run(command):
    done = subprocess.run(command, check=False, capture_output=True, timeout=1200)
    if done.returncode:
        raise RuntimeError(done.stderr.decode(errors="replace")[-1400:])
    return done.stdout


def ffmpeg(*args):
    return run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            *map(str, args),
        ]
    )


def download(base, url, dest, limit=20 * 1024 * 1024, secret=""):
    # Layouts can refer to public logos elsewhere on this origin. Only worker-owned
    # file routes receive the Bearer; a storage redirect never inherits this header.
    origin = urlsplit(base)
    resolved = urljoin(base + "/", url)
    target = urlsplit(resolved)
    if target[:2] != origin[:2] or target.scheme not in ("https", "http"):
        raise ValueError("Media URL must belong to the contest server")
    prefix = origin.path.rstrip("/") + "/"
    tail = target.path.removeprefix(prefix) if target.path.startswith(prefix) else ""
    protected = re.fullmatch(
        r"(?:files/(?:assets|segments)/[A-Za-z0-9_-]+|clips/[a-fA-F0-9]{24}/(?:screen|webcam))",
        tail,
    )
    headers = {"Authorization": "Bearer " + secret} if secret and protected else {}
    for _ in range(6):
        with requests.get(
            resolved,
            headers=headers,
            allow_redirects=False,
            stream=True,
            timeout=(10, 90),
        ) as response:
            if response.is_redirect:
                resolved = urljoin(resolved, response.headers["Location"])
                target = urlsplit(resolved)
                if (
                    target.scheme not in ("https", "http")
                    or not target.hostname
                    or target.username is not None
                ):
                    raise ValueError("Invalid storage redirect")
                headers = {}
                continue
            response.raise_for_status()
            size = 0
            with dest.open("wb") as output:
                for block in response.iter_content(256 * 1024):
                    size += len(block)
                    if size > limit:
                        raise ValueError("Media exceeds its size limit")
                    output.write(block)
            return dest
    raise ValueError("Too many storage redirects")


def timeline(segments, start, end):
    """Return disjoint spans in wall-clock order, including uncovered intervals."""
    cursor = start
    for segment in sorted(segments, key=lambda s: s["startMs"]):
        left = max(cursor, segment["startMs"])
        right = min(end, segment["endMs"])
        if right <= left:
            continue
        if left > cursor:
            yield None, 0, left - cursor
        yield segment, left - segment["startMs"], right - left
        cursor = right
    if cursor < end:
        yield None, 0, end - cursor


def scale(width, height, fit):
    mode = "increase" if fit == "cover" else "decrease"
    finish = (
        f"crop={width}:{height}"
        if fit == "cover"
        else f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
    )
    return f"scale={width}:{height}:force_original_aspect_ratio={mode}:force_divisible_by=2,{finish},setsar=1"


def color(value, fallback="#172435"):
    return (
        value
        if isinstance(value, str) and re.fullmatch(r"#[a-fA-F0-9]{6}", value)
        else fallback
    )


def has_audio(path):
    streams = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "mov,matroska,webm",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "json",
            str(path),
        ]
    )
    return bool(json.loads(streams)["streams"])


def make_track(folder, kind, spans, assets, item, bg):
    w, h = item["width"], item["height"]
    chunks = []
    elapsed = frames = 0
    for index, (segment, offset, length) in enumerate(spans):
        elapsed += length
        next_frames = round(elapsed * FPS / 1000)
        if next_frames == frames:
            continue
        seconds = (next_frames - frames) / FPS
        frames = next_frames
        output = folder / f"{kind}-{index}.mp4"
        args = []
        audio = False
        if segment:
            path = assets[segment["url"]]
            args += [
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                "mov,matroska,webm",
                "-ss",
                f"{offset / 1000:.3f}",
                "-i",
                path,
            ]
            audio = kind == "webcam" and has_audio(path)
        else:
            args += ["-f", "lavfi", "-i", f"color=c={bg}:s={w}x{h}:r={FPS}"]
        if not audio:
            args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
        # Some recorder fragments end one frame earlier than their wall clock.
        ffmpeg(
            *args,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0" if audio else "1:a:0",
            "-vf",
            f"{scale(w, h, item.get('fit'))},fps={FPS},tpad=stop_mode=clone:stop_duration={seconds}",
            "-af",
            "apad",
            "-t",
            f"{seconds:.3f}",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            17,
            "-pix_fmt",
            "yuv420p",
            "-ar",
            48000,
            "-ac",
            2,
            "-c:a",
            "aac",
            output,
        )
        chunks.append(output)
    manifest = folder / f"{kind}.txt"
    manifest.write_text("".join(f"file '{p.name}'\n" for p in chunks))
    out = folder / f"{kind}.mp4"
    ffmpeg("-f", "concat", "-safe", "1", "-i", manifest, "-c", "copy", out)
    return out


def lettering(canvas, lines, ink, box, font_path):
    draw = ImageDraw.Draw(canvas)
    x, y, w, h = box
    line_h = h / max(1, len(lines))
    for i, line in enumerate(lines):
        text = str(line)[:250]
        size = max(9, min(160, int(line_h * 0.64)))
        font = ImageFont.truetype(str(font_path), size)
        measured = draw.textlength(text, font=font)
        if measured > w:
            font = ImageFont.truetype(str(font_path), max(5, int(size * w / measured)))
        draw.text((x, y + (i + 0.5) * line_h), text, font=font, fill=ink, anchor="lm")


def graphic(folder, idx, item, layout, detail, logo, font, judged=True):
    w, h = item["width"], item["height"]
    props = item.get("props", {})
    im = Image.new("RGBA", (w, h))
    if item["kind"] == "text":
        lettering(
            im,
            [props.get("text", "")],
            color(props.get("color"), "#ffffff"),
            (0, 0, w, h),
            font,
        )
    else:
        card = layout.get("card", {})
        im.paste(color(card.get("primary")), (0, 0, w, h))
        team, problem = detail["team"], detail["problem"]
        org = team.get("organization") or {}
        verdict = (detail.get("result") or {}).get("verdict") or {}
        minute = int(detail.get("time", 0)) // 60000
        fields = card.get("fields", ["team", "problem", "verdict", "time", "rank"])
        margin = max(2, int(min(w, h) * 0.06))
        x = margin
        if "logo" in fields and logo:
            with Image.open(logo) as source:
                icon = source.convert("RGBA")
                icon.thumbnail((max(1, w // 4), max(1, h - 2 * margin)))
                im.alpha_composite(icon, (margin, (h - icon.height) // 2))
                x += icon.width + margin
        ink = color(card.get("text"), "#ffffff")
        # Like the upstream card, the team and school sit beside the task and verdict,
        # with the standing in a badge above them. Only selected fields occupy space.
        rank_height = h // 4 if "rank" in fields else 0
        if rank_height:
            before, after = team.get("rankBefore", "–"), team.get("rankAfter", "–")
            rank = (
                f"#{before} → #{after}" if judged and before != after else f"#{before}"
            )
            lettering(
                im, [rank], ink, (x, 0, max(1, w - x - margin), rank_height), font
            )
        top = rank_height + margin
        name = [team.get("displayName", "")] if "team" in fields else []
        if "school" in fields:
            name.append(org.get("displayName") or org.get("fullName") or "")
        task = [str(problem.get("letter", ""))] if "problem" in fields else []
        if "time" in fields:
            task.append(f"{minute // 60}:{minute % 60:02d}")
        result = (verdict.get("shortName") or "") if judged else "评测中"
        info = [" · ".join(task)] if task else []
        if "verdict" in fields:
            info.append(result)
        usable = max(1, w - x - margin)
        left = int(usable * 0.58) if name and info else usable if name else 0
        lettering(im, name, ink, (x, top, left, max(1, h - top - margin)), font)
        if info:
            off = x + left + (margin if left else 0)
            lettering(
                im,
                info,
                ink,
                (off, top, max(1, w - off - margin), max(1, h - top - margin)),
                font,
            )
        if "problem" in fields and problem.get("color"):
            ImageDraw.Draw(im).rectangle(
                (0, 0, max(1, margin // 2), h), fill=color(problem["color"])
            )
    out = folder / f"layer-{idx}-{int(judged)}.png"
    im.save(out)
    return out


def render(
    base, task, detail, work, output, encoder="cpu", font=FONT, sound=None, secret=""
):
    layout = task["layout"]
    width, height = (int(layout["canvas"][k]) for k in ("width", "height"))
    if not all(16 <= n <= 3840 and n % 2 == 0 for n in (width, height)):
        raise ValueError("Invalid canvas")
    media = {
        r["hydro"]["stream"]: r["hydro"]
        for r in detail["reactionVideos"]
        if r.get("hydro")
    }
    if not media:
        raise ValueError("No recording window for this submission")
    window = next(iter(media.values()))
    start, end = window["windowStartMs"], window["windowEndMs"]
    duration = (end - start) / 1000
    if not math.isfinite(duration) or not 0 < duration <= 120:
        raise ValueError("Invalid recording window")
    bg = layout.get("background", {})
    background = color(bg.get("color"))
    items = sorted(
        (i for i in layout["items"] if i.get("visible", True)), key=lambda i: i["z"]
    )
    items = [dict(i) for i in items]
    urls = set()
    org = detail.get("team", {}).get("organization") or {}
    logo = (org.get("logo") or {}).get("url")
    if logo and any(
        i["kind"] == "logo"
        or (i["kind"] == "card" and "logo" in layout.get("card", {}).get("fields", []))
        for i in items
    ):
        urls.add(logo)
    if bg.get("image"):
        urls.add(bg["image"])
    for item in items:
        if not all(
            isinstance(item[k], int) and 1 <= item[k] <= 7680
            for k in ("width", "height")
        ):
            raise ValueError("Invalid layer size")
        if encoder == "nvidia_full" and (
            item["x"] < 0
            or item["y"] < 0
            or item["x"] + item["width"] > width
            or item["y"] + item["height"] > height
        ):
            raise ValueError("CUDA overlays must fit inside the canvas")
        if item["kind"] in media:
            urls.update(
                s["url"]
                for s in media[item["kind"]]["segments"]
                if s["endMs"] > start and s["startMs"] < end
            )
        elif item["kind"] == "image" and item.get("props", {}).get("image"):
            urls.add(item["props"]["image"])
    assets = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        jobs = {
            url: pool.submit(download, base, url, work / f"input-{i}", secret=secret)
            for i, url in enumerate(sorted(urls))
        }
        for url, job in jobs.items():
            assets[url] = job.result()
    args = ["-f", "lavfi", "-i", f"color=c={background}:s={width}x{height}:r={FPS}"]
    cuda = encoder == "nvidia_full"
    init = ",format=yuv420p,hwupload" if cuda else ""
    graph = [f"[0:v]setsar=1{init}[layer0]"]
    layers = []
    if bg.get("image"):
        layers.append(
            (
                assets[bg["image"]],
                {"width": width, "height": height, "x": 0, "y": 0, "fit": "cover"},
                True,
            )
        )
    voice = None
    for idx, item in enumerate(items):
        kind = item["kind"]
        # Chroma subsampling requires even rectangles for the encoded video tracks.
        item["width"] += item["width"] % 2
        item["height"] += item["height"] % 2
        if kind in ("screen", "webcam"):
            track = make_track(
                work,
                kind,
                timeline(media.get(kind, {}).get("segments", []), start, end),
                assets,
                item,
                background,
            )
            if kind == "webcam":
                voice = len(layers) + 1
            layers.append((track, item, False))
        elif kind in ("card", "text"):
            final = graphic(work, idx, item, layout, detail, assets.get(logo), font)
            reveal = max(
                0, min(duration, (detail.get("judgedAtMs", start) - start) / 1000)
            )
            if kind == "card" and reveal > 0:
                before = graphic(
                    work,
                    idx,
                    item,
                    layout,
                    detail,
                    assets.get(logo),
                    font,
                    judged=False,
                )
                manifest = work / f"card-{idx}.ffconcat"
                manifest.write_text(
                    f"ffconcat version 1.0\nfile '{before.name}'\nduration {reveal:.3f}\nfile '{final.name}'\n"
                )
                layers.append((manifest, item, False))
            else:
                layers.append((final, item, True))
        elif kind in ("logo", "image"):
            asset = assets.get(
                logo if kind == "logo" else item.get("props", {}).get("image")
            )
            if asset:
                layers.append((asset, item, True))
    for idx, (src, item, still) in enumerate(layers, 1):
        if still:
            args += ["-loop", "1", "-framerate", str(FPS)]
        args += ["-i", src]
        upload = (
            (",format=yuva420p,hwupload" if still else ",format=yuv420p,hwupload")
            if cuda
            else ""
        )
        graph.append(
            f"[{idx}:v]{scale(item['width'], item['height'], item.get('fit'))}{upload}[asset{idx}]"
        )
        graph.append(
            f"[layer{idx - 1}][asset{idx}]{'overlay_cuda' if cuda else 'overlay'}=x={int(item['x'])}:y={int(item['y'])}:eof_action=repeat[layer{idx}]"
        )
    aud = []
    if voice is not None:
        aud.append(f"[{voice}:a:0]")
    if sound and Path(sound).is_file():
        args += ["-i", sound]
        offset = max(0, min(end - start, detail.get("judgedAtMs", end) - start))
        graph.append(f"[{len(layers) + 1}:a]adelay={int(offset)}:all=1[sfx]")
        aud.append("[sfx]")
    if aud:
        graph.append("".join(aud) + f"amix=inputs={len(aud)}:normalize=0,apad[audio]")
    codecs = {
        "cpu": ["libx264", "-crf", "22", "-preset", "veryfast"],
        "apple": ["h264_videotoolbox", "-q:v", "65"],
        "nvidia": ["h264_nvenc", "-cq", "26", "-rc", "vbr", "-b:v", "0"],
        "qsv": ["h264_qsv", "-global_quality", "24"],
    }
    codecs["nvidia_full"] = codecs["nvidia"]
    codecs["vaapi"] = ["h264_vaapi", "-qp", "24"]
    device = (
        ["-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu"] if cuda else []
    )
    out_label = f"[layer{len(layers)}]"
    if encoder == "vaapi":
        device = ["-vaapi_device", "/dev/dri/renderD128"]
        graph.append(f"{out_label}format=nv12,hwupload[vaout]")
        out_label = "[vaout]"
    if encoder not in codecs:
        raise ValueError(f"Unsupported encoder {encoder}")
    ffmpeg(
        *device,
        *args,
        "-filter_complex_threads",
        2,
        "-filter_complex",
        ";".join(graph),
        "-map",
        out_label,
        *(["-map", "[audio]", "-c:a", "aac"] if aud else []),
        "-c:v",
        *codecs[encoder],
        *([] if cuda or encoder == "vaapi" else ["-pix_fmt", "yuv420p"]),
        "-t",
        f"{duration:.3f}",
        "-movflags",
        "+faststart",
        output,
    )
    return round(duration * 1000)
