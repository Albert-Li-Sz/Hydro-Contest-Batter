import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

if (Path(__file__).resolve().parent / "hydro_worker.py").exists():
    import hydro_render as media
    import hydro_worker as worker
else:
    from reactions_generator import hydro_render as media
    from reactions_generator import hydro_worker as worker


class WorkerTests(unittest.TestCase):
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

            class Server(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def send_blob(self, status, data):
                    self.send_response(status)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)

                def do_GET(self):
                    if self.path == "/segment":
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
                            "reactionVideos": [video("/segment")],
                        }
                    )
                    self.send_blob(200, json.dumps(data).encode())

                def do_POST(self):
                    beats.append(
                        json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    )
                    self.send_blob(200, b"{}")

                def do_PUT(self):
                    writes.append(self.rfile.read(int(self.headers["Content-Length"])))
                    self.send_blob(503 if len(writes) == 1 else 200, b"{}")

            server = ThreadingHTTPServer(("127.0.0.1", 0), Server)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.object(worker.time, "sleep", return_value=None):
                    worker.process_partition(
                        f"http://127.0.0.1:{server.server_port}/api",
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
