"""The fixed ICPC compositions. The published worker includes the pinned upstream package."""

from functools import lru_cache
from pathlib import Path
from unicodedata import east_asian_width

from PIL import Image, ImageFont, ImageOps

HERE = Path(__file__).resolve().parent
PORTRAIT = HERE / "templates/portrait.png"
if not PORTRAIT.exists():
    PORTRAIT = HERE.parent / "resolver/public/assets/reaction-template/portrait.png"


@lru_cache(maxsize=2)
def cjk_font(weight):
    # Pillow calls font_variant as the upstream fitter measures and resizes a label.
    class LabelFont(ImageFont.FreeTypeFont):
        def font_variant(self, *args, **kwargs):
            font = super().font_variant(*args, **kwargs)
            font.set_variation_by_axes([weight])
            return font

    path = HERE / "fonts/NotoSansSC-VF.ttf"
    if not path.exists():
        path = HERE.parent / "resolver/public/assets/font/NotoSansSC-VF.ttf"
    return LabelFont(str(path), 10)


def label_font(label, original, weight):
    if any(ord(c) > 255 and east_asian_width(c) in ("W", "F", "A") for c in label):
        return cjk_font(weight)
    return original


def rectangles(template):
    from reactions_generator.composition import _aligned_position
    from reactions_generator.defaults import Defaults

    suffix = {"icpc-portrait": "", "icpc-landscape": "_h"}[template]
    layers = []
    for kind in ("webcam", "screen", "card"):
        rect = getattr(Defaults, kind + "_position" + suffix)
        x, y, width, height = _aligned_position(rect)
        layers.append(dict(kind=kind, x=x, y=y, width=width, height=height, fit="fill"))
    return layers


def backdrop(folder, artwork):
    if not artwork:
        return PORTRAIT
    with Image.open(PORTRAIT) as source, Image.open(artwork) as custom:
        frame = source.convert("RGB")
        strip = ImageOps.fit(
            ImageOps.exif_transpose(custom).convert("RGBA"),
            (1080, 192),
            method=Image.Resampling.LANCZOS,
        )
        frame.paste("white", (0, 1728, 1080, 1920))
        frame.paste(strip, (0, 1728), strip)
        target = folder / "backdrop.png"
        frame.save(target)
        return target


def submission_card(detail, logo_path, reveal, fps):
    from reactions_generator.card import Card

    team = detail["team"]
    org = team.get("organization") or {}
    verdict = (detail.get("result") or {}).get("verdict") or {}
    logo = Image.new("RGBA", (152, 152))
    if logo_path:
        with Image.open(logo_path) as source:
            logo = source.convert("RGBA")
    hashtag = team.get("hashTag") or ""
    return Card(
        title=team.get("displayName") or team.get("fullName") or "",
        subtitle=(team.get("customFields") or {}).get("clicsTeamFullName")
        or org.get("fullName")
        or org.get("displayName")
        or "",
        hashtag=("#" + hashtag.lstrip("#")) if hashtag else "",
        task=detail["problem"].get("letter", ""),
        time=detail.get("time", 0),
        outcome=verdict.get("shortName", ""),
        success=bool(verdict.get("isAccepted")),
        rank_before=team.get("rankBefore") or 1,
        rank_after=team.get("rankAfter") or team.get("rankBefore") or 1,
        logo=logo,
        animation_start=reveal,
        fps=fps,
        width=1000,
        height=306,
    )


def animated_card(folder, detail, logo, start, duration, fps):
    from reactions_generator.rendering import run_card_command

    last_frame = max(0, round(duration * fps) - 1)
    reveal = max(0, round((detail.get("judgedAtMs", start) - start) * fps / 1000))
    card = submission_card(detail, logo, reveal, fps)
    target = folder / "card.mov"
    run_card_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            "1000x306",
            "-r",
            str(fps),
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "qtrle",
            "-pix_fmt",
            "argb",
            str(target),
        ],
        card,
        min(last_frame, reveal + 10),
        str(target),
        False,
    )
    return target
