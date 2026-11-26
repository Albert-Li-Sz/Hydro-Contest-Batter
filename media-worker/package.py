"""Build the separate media-machine source archive from a pinned upstream checkout."""

import argparse
import hashlib
import io
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

PIN = "5d42acb846870b032605d161cf26f26ca556e77e"
UPSTREAM = "https://github.com/icpc/reactions-generator.git"
HERE = Path(__file__).resolve().parent


def build(output, checkout):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        if checkout is None:
            checkout = root / "repo"
            subprocess.run(
                [
                    "git",
                    "clone",
                    "--filter=blob:none",
                    "--no-checkout",
                    UPSTREAM,
                    str(checkout),
                ],
                check=True,
            )
        archive = subprocess.check_output(["git", "-C", str(checkout), "archive", PIN])
        source = root / "src"
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(source, filter="data")
        (source / ".dockerignore").write_text(
            ".env\n.env.*\nout/\n.git/\n.venv/\n__pycache__/\n"
        )
        pkg = source / "reactions_generator"
        for name in [
            "hydro_connection.py",
            "hydro_render.py",
            "hydro_template.py",
            "hydro_worker.py",
        ]:
            shutil.copy2(HERE / name, pkg)
        shutil.copy2(HERE / "test_hydro_worker.py", source / "tests")
        shutil.copy2(HERE / "docker-compose.yml", source / "docker-compose.yml")
        shutil.copy2(HERE / "LICENSE-upstream-MIT.txt", source / "LICENSE")
        (pkg / "fonts").mkdir()
        shutil.copy2(
            HERE.parent / "resolver/public/assets/font/NotoSansSC-VF.ttf", pkg / "fonts"
        )
        shutil.copy2(HERE.parent / "licenses/Noto-Sans-SC-OFL.txt", pkg / "fonts")
        (pkg / "templates").mkdir()
        shutil.copy2(
            HERE.parent / "resolver/public/assets/reaction-template/portrait.png",
            pkg / "templates",
        )
        card = pkg / "card.py"
        card_source = card.read_text()
        headline = "                load_bold(10),"
        caption = "                load_regular(10),"
        assert card_source.count(headline) == 2 and card_source.count(caption) == 1
        card.write_text(
            card_source.replace(
                "from reactions_generator.colors import Colors",
                "from reactions_generator.colors import Colors\nfrom reactions_generator.hydro_template import label_font",
            )
            .replace(
                headline,
                "                label_font(self.title, load_bold(10), 700),",
                1,
            )
            .replace(
                caption,
                '                label_font(f"{self.subtitle} {self.hashtag}", load_regular(10), 400),',
            )
        )
        worker = pkg / "worker.py"
        original = worker.read_text()
        signature = "    poll_interval: float = 2.0,\n) -> None:"
        entry = "    if total_workers <= 0 or ("
        assert original.count(signature) == original.count(entry) == 1
        required_url = "def continuous_build_submission(\n    url: str,"
        assert original.count(required_url) == 1
        original = original.replace(
            "import ffmpeg",
            "from typing import Annotated\n\nimport ffmpeg\nimport typer",
        ).replace(
            required_url,
            "def continuous_build_submission(\n    url: Annotated[str | None, typer.Argument()] = None,",
        )
        cli = pkg / "cli.py"
        cli.write_text(
            cli.read_text().replace(
                "typer.Typer(no_args_is_help=True)",
                "typer.Typer(no_args_is_help=True, pretty_exceptions_show_locals=False)",
            )
        )
        worker.write_text(
            original.replace(
                signature,
                "    poll_interval: float = 2.0,\n    hydro_upload: bool = False,\n) -> None:",
            ).replace(
                entry,
                "    if hydro_upload:\n        from reactions_generator.hydro_worker import continuous\n\n        continuous(url, output_directory, total_workers, worker_id, hardware, poll_interval, sound)\n        return\n"
                + '    if not url:\n        raise ValueError("Supply a contest URL, or use --hydro-upload with .env")\n'
                + entry,
            )
        )
        shutil.copy2(HERE.parent / "LICENSE", source / "LICENSE-Hydro-MIT.txt")
        shutil.copy2(HERE.parent / "NOTICE", source / "NOTICE")
        shutil.copy2(HERE / "README.md", source / "HYDRO.md")
        (source / "README.md").write_text(
            (source / "README.md").read_text()
            + "\nHydro contest mode: see [HYDRO.md](HYDRO.md).\n"
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(output, "w:gz") as tar:
            tar.add(source, arcname="reactions-generator-hydro")
        print(output.name, hashlib.file_digest(output.open("rb"), "sha256").hexdigest())


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("output", type=Path)
    args.add_argument("--checkout", type=Path)
    opt = args.parse_args()
    build(opt.output, opt.checkout)
