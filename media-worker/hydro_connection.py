"""Load the operator's media connection without putting its key in process arguments."""

import base64
import binascii
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Connection:
    base: str = field(repr=False)
    token: str = field(default="", repr=False)


def parse_connection(value):
    value = value.strip()
    if not value.startswith("hydro-reactions:"):
        parts = urlsplit(value)
        if (
            parts.scheme not in ("http", "https")
            or not parts.hostname
            or parts.username is not None
            or parts.query
            or parts.fragment
        ):
            raise ValueError("Invalid media worker URL")
        return Connection(value.rstrip("/"))
    try:
        encoded = value.removeprefix("hydro-reactions:")
        if len(encoded) > 16384 or not re.fullmatch(r"[A-Za-z0-9_-]+", encoded):
            raise ValueError
        raw = base64.b64decode(
            encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True
        )
        data = json.loads(raw)
        if (
            not isinstance(data, dict)
            or type(data.get("v")) is not int
            or data["v"] != 1
        ):
            raise ValueError
        base, machine, token = data["url"], data["id"], data["token"]
        parts = urlsplit(base)
        if (
            not re.fullmatch(r"[a-fA-F0-9]{24}", machine)
            or not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", token)
            or parts.scheme not in ("http", "https")
            or not parts.hostname
            or parts.username is not None
            or parts.query
            or parts.fragment
            or not re.search(
                r"/contest/[a-fA-F0-9]{24}/reactions-api/workers/" + machine + r"$",
                parts.path,
            )
            or "\\" in base
            or any(c.isspace() for c in base)
        ):
            raise ValueError
        return Connection(base, token)
    except (ValueError, TypeError, KeyError, AttributeError, binascii.Error):
        raise ValueError(
            "Invalid HYDRO_MEDIA_CONNECTION; copy a fresh connection from the contest"
        ) from None


def load_connection(value=None):
    if value:
        return parse_connection(value)
    keys = ("HYDRO_MEDIA_CONNECTION", "HYDRO_REACTIONS_API")
    values = {k: os.getenv(k, "") for k in keys}
    mount = Path("/run/secrets/hydro_media_env")
    path = mount if mount.is_file() else Path(".env")
    if path.is_file():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            name, separator, raw = line.strip().removeprefix("export ").partition("=")
            name = name.strip()
            if separator and name in keys:
                raw = re.split(r"\s+#", raw.strip(), maxsplit=1)[0].strip()
                if len(raw) >= 2 and raw[0] in "\"'" and raw[0] == raw[-1]:
                    raw = raw[1:-1]
                if raw:
                    values[name] = raw
    for key in keys:
        if values[key]:
            return parse_connection(values[key])
    raise ValueError("Set HYDRO_MEDIA_CONNECTION in the media worker .env file")


def safe_error(exc, connection):
    message = str(exc).replace(connection.base, "<contest>")
    secret = connection.token or urlsplit(connection.base).path.rsplit("/", 1)[-1]
    if secret:
        message = message.replace(secret, "<redacted>")
    message = re.sub(r"hydro-reactions:[A-Za-z0-9_-]+", "<connection>", message)
    return re.sub(
        r"([?&](?:sig|signature|token|x-amz-[a-z-]+)=)[^&\s]+",
        r"\1<redacted>",
        message,
        flags=re.I,
    )[-1800:]
