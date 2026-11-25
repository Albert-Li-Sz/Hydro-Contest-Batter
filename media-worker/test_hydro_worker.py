import base64
import importlib.util
import subprocess
import json
import os
from contextlib import chdir
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

if (Path(__file__).resolve().parent / "hydro_worker.py").exists():
    import hydro_connection as connection
    import hydro_render as media
    import hydro_worker as worker
else:
    from reactions_generator import hydro_connection as connection
    from reactions_generator import hydro_render as media
    from reactions_generator import hydro_worker as worker


MACHINE = "a" * 24
CONTEST = "b" * 24
API_PATH = f"/d/system/contest/{CONTEST}/reactions-api/workers/{MACHINE}"
TEST_KEY = "fixture-media-key-123456"


def connection_code(base, **changes):
    data = {"v": 1, "url": base, "id": MACHINE, "token": TEST_KEY, **changes}
    return (
        "hydro-reactions:"
        + base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()
    )


class WorkerTests(unittest.TestCase):
    def test_new_connection_file_and_legacy_environment(self):
        base = "https://hydro.example" + API_PATH
        code = connection_code(base)
        with (
            tempfile.TemporaryDirectory() as folder,
            chdir(folder),
            patch.dict(os.environ, {}, clear=True),
        ):
            Path(".env").write_text(
                "# media desk\nHYDRO_MEDIA_CONNECTION='" + code + "' # current key\n"
            )
            conn = connection.load_connection()
            self.assertEqual((conn.base, conn.token), (base, TEST_KEY))
            self.assertNotIn(TEST_KEY, repr(conn))
            self.assertNotIn(code, repr(conn))
            Path(".env").unlink()
            with self.assertRaisesRegex(ValueError, "Set HYDRO_MEDIA_CONNECTION"):
                connection.load_connection()
            legacy = "https://old.example/reactions-api/legacyKey"
            with patch.dict(os.environ, {"HYDRO_REACTIONS_API": legacy}):
                self.assertEqual(connection.load_connection().base, legacy)
                self.assertFalse(connection.load_connection().token)

    def test_rejects_invalid_connection_without_echo(self):
        base = "https://hydro.example" + API_PATH
        for code in [
            connection_code(base, v=2),
            connection_code(base, id="0" * 24),
            connection_code(base + "?debug=1"),
            connection_code("file:///tmp/" + MACHINE),
            connection_code(
                "https://example.org/d/bad/contest/x/reactions-api/workers/" + MACHINE
            ),
            connection_code(base.replace("://", "://someone@")),
            "hydro-reactions:@invalid",
        ]:
            with (
                self.subTest(codeLength=len(code)),
                self.assertRaises(ValueError) as raised,
            ):
                connection.parse_connection(code)
            self.assertNotIn(code, str(raised.exception))
            self.assertNotIn(TEST_KEY, str(raised.exception))

    def test_log_redaction(self):
        base = "https://example.org" + API_PATH
        code = connection_code(base)
        message = connection.safe_error(
            RuntimeError(
                f"{code} {TEST_KEY} https://store/object?X-Amz-Signature=storage-secret"
            ),
            connection.parse_connection(code),
        )
        for secret in (code, TEST_KEY, "storage-secret"):
            self.assertNotIn(secret, message)

    def test_icpc_decoration_changes_only_the_footer(self):
        from PIL import Image, ImageChops

        if (Path(__file__).resolve().parent / "hydro_worker.py").exists():
            import hydro_template as template
        else:
            from reactions_generator import hydro_template as template
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            replacement = folder / "strip.png"
            Image.new("RGB", (90, 110), "cyan").save(replacement)
            with Image.open(template.PORTRAIT) as source, Image.open(template.backdrop(folder, replacement)) as rendered:
                changed = ImageChops.difference(source.convert("RGB"), rendered)
                self.assertEqual(changed.getbbox(), (0, 1728, 1080, 1920))
                self.assertEqual(rendered.getpixel((0, 1728)), (0, 255, 255))

    @unittest.skipUnless(importlib.util.find_spec("reactions_generator"), "requires the packaged upstream renderer")
    def test_fixed_templates_encode_both_sources_and_the_upstream_card(self):
        from PIL import Image
        from reactions_generator import hydro_template as template
        import io

        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            assets = {}
            streams = []
            for kind, color in (("screen", "blue"), ("webcam", "red")):
                source = folder / (kind + ".mp4")
                subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i",
                                f"color=c={color}:s=96x54:r=24", "-t", "1", "-c:v", "libx264", str(source)], check=True)
                assets[kind] = source
                streams.append({"hydro": {"stream": kind, "windowStartMs": 1000, "windowEndMs": 2000,
                                          "segments": [{"url": kind, "startMs": 1000, "endMs": 2000}]}})
            detail = {"team": {"displayName": "示例队", "rankBefore": 8, "rankAfter": 4},
                      "problem": {"letter": "A"}, "result": {"verdict": {"shortName": "AC", "isAccepted": True}},
                      "time": 60000, "judgedAtMs": 1500, "reactionVideos": streams}
            card = template.submission_card(detail, None, 15, 30)
            for orientation in ("icpc-portrait", "icpc-landscape"):
                working = folder / orientation
                working.mkdir()
                target = working / "result.mp4"
                with patch.object(media, "download", side_effect=lambda _, url, dest, **kwargs: assets[url]):
                    duration = media.render("http://localhost", {"layout": {"template": orientation}}, detail, working, target)
                self.assertEqual(duration, 1000)
                layers = {item["kind"]: item for item in template.rectangles(orientation)}
                for frame in (3, 24):
                    data = subprocess.check_output(["ffmpeg", "-loglevel", "error", "-i", str(target),
                        "-vf", f"select=eq(n\\,{frame})", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"])
                    with Image.open(io.BytesIO(data)) as output:
                        self.assertEqual(output.size, (1080, 1920) if orientation.endswith("portrait") else (1920, 1080))
                        for kind, channel in (("screen", 2), ("webcam", 0)):
                            item = layers[kind]
                            x, y = item["x"] + item["width"] // 2, item["y"] + item["height"] // 2
                            self.assertGreater(output.getpixel((x, y))[channel], 230)
                        item = layers["card"]
                        expected = card.render_frame(frame).getpixel((500, 100))[:3]
                        actual = output.getpixel((item["x"] + 500, item["y"] + 100))[:3]
                        self.assertLess(max(abs(a-b) for a,b in zip(actual, expected)), 14)

    def test_timeline(self):
        a = {"startMs": 900, "endMs": 1400}
        b = {"startMs": 1350, "endMs": 1500}
        c = {"startMs": 1700, "endMs": 2300}
        self.assertEqual(
            list(media.timeline([c, b, a], 1000, 2000)),
            [(a, 100, 400), (b, 50, 100), (None, 0, 200), (c, 0, 300)],
        )

    def test_partition(self):
        self.assertEqual(worker.partition("abc", 3), worker.partition("abc", 3))
        self.assertEqual({worker.partition(str(i), 2) for i in range(20)}, {0, 1})

    def test_asset_url(self):
        with self.assertRaises(ValueError):
            media.download("https://contest.test/d/a", "file:///tmp/a", Path("unused"))

    def test_render_upload_and_retry(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            segment = folder / "red.mp4"
            media.ffmpeg(
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=64x64:r=25:d=1",
                "-f",
                "lavfi",
                "-i",
                "sine=duration=1",
                "-shortest",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                segment,
            )
            layout = {
                "id": "square",
                "canvas": {"width": 128, "height": 128},
                "background": {"color": "#000000"},
                "card": {
                    "fields": ["team", "verdict"],
                    "text": "#ffffff",
                    "primary": "#294060",
                },
                "items": [
                    {
                        "id": "cam",
                        "kind": "webcam",
                        "x": 0,
                        "y": 0,
                        "width": 64,
                        "height": 64,
                        "z": 0,
                        "fit": "cover",
                    },
                    {
                        "id": "card",
                        "kind": "card",
                        "x": 0,
                        "y": 64,
                        "width": 128,
                        "height": 64,
                        "z": 1,
                    },
                ],
            }
            task = {
                "layout": layout,
                "runId": "abc",
                "layoutId": "square",
                "priority": 0,
                "generation": 1,
            }

            def video(blob):
                return {
                    "type": "Video",
                    "hydro": {
                        "stream": "webcam",
                        "windowStartMs": 100,
                        "windowEndMs": 2100,
                        "segments": [
                            {"url": blob, "startMs": 0, "endMs": 900},
                            {"url": blob, "startMs": 1300, "endMs": 2200},
                        ],
                    },
                }

            writes = []
            beats = []
            observed = []
            media_path = API_PATH + "/files/segments/testsegment"

            class Server(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def send_blob(self, status, data):
                    self.send_response(status)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)

                def do_GET(self):
                    observed.append((self.path, self.headers.get("Authorization")))
                    if self.path == media_path:
                        self.send_response(302)
                        self.send_header("Location", "/storage/temporary")
                        self.end_headers()
                        return
                    if self.path == "/storage/temporary":
                        self.send_blob(200, segment.read_bytes())
                        return
                    data = (
                        {"layouts": [layout], "tasks": [task]}
                        if self.path.endswith("layouts.json")
                        else {
                            "judgedAtMs": 1250,
                            "team": {"displayName": "示例队伍", "organization": {}},
                            "problem": {"letter": "A"},
                            "result": {"verdict": {"shortName": "AC"}},
                            "reactionVideos": [video(media_path)],
                        }
                    )
                    self.send_blob(200, json.dumps(data).encode())

                def do_POST(self):
                    observed.append((self.path, self.headers.get("Authorization")))
                    beats.append(
                        json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    )
                    self.send_blob(200, b"{}")

                def do_PUT(self):
                    observed.append((self.path, self.headers.get("Authorization")))
                    writes.append(self.rfile.read(int(self.headers["Content-Length"])))
                    self.send_blob(503 if len(writes) == 1 else 200, b"{}")

            server = ThreadingHTTPServer(("127.0.0.1", 0), Server)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.object(worker.time, "sleep", return_value=None):
                    worker.process_partition(
                        connection_code(
                            f"http://127.0.0.1:{server.server_port}" + API_PATH
                        ),
                        folder,
                        0,
                        1,
                        once=True,
                        with_sound=False,
                    )
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
            self.assertIn(("/storage/temporary", None), observed)
            for path, auth in observed:
                self.assertNotIn(TEST_KEY, path)
                if path.startswith(API_PATH + "/"):
                    self.assertEqual(auth, "Bearer " + TEST_KEY, path)
            final = next(folder.glob("*/*.mp4"))
            for body in writes:
                self.assertIn(final.read_bytes(), body)
            self.assertEqual(len(writes), 2)
            self.assertTrue(any(b["current"] for b in beats))
            info = json.loads(
                media.run(
                    [
                        "ffprobe",
                        "-v",
                        "error",
                        "-show_streams",
                        "-show_format",
                        "-of",
                        "json",
                        str(final),
                    ]
                )
            )
            self.assertEqual(
                [(s["codec_type"], s["codec_name"]) for s in info["streams"]],
                [("video", "h264"), ("audio", "aac")],
            )
            self.assertAlmostEqual(float(info["format"]["duration"]), 2, delta=0.08)
            self.assertLess(
                final.read_bytes().index(b"moov"), final.read_bytes().index(b"mdat")
            )
            for at, red in [(0.24, True), (1.00, False), (1.60, True)]:
                pixel = media.ffmpeg(
                    "-ss",
                    at,
                    "-i",
                    final,
                    "-frames:v",
                    1,
                    "-vf",
                    "format=rgb24,crop=1:1:32:32",
                    "-f",
                    "rawvideo",
                    "pipe:1",
                )
                self.assertEqual(pixel[0] > 160 and pixel[1] < 65, red, (at, pixel))


if __name__ == "__main__":
    unittest.main()
