from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

USER_AGENT = (
    "japan-flags/0.1 "
    "(https://github.com/saqula/japan-flags; municipal flag data ingestion)"
)
RETRY_STATUSES = {429, 500, 502, 503, 504}


def request_bytes(
    url: str,
    *,
    accept: str = "*/*",
    attempts: int = 5,
) -> bytes:
    last_error: Exception | None = None

    for attempt in range(attempts):
        request = Request(
            url,
            headers={"Accept": accept, "User-Agent": USER_AGENT},
        )
        try:
            with urlopen(request, timeout=60) as response:
                return response.read()
        except HTTPError as error:
            last_error = error
            if error.code not in RETRY_STATUSES:
                raise
            retry_after = error.headers.get("Retry-After")
            delay = (
                min(float(retry_after), 10.0)
                if retry_after and retry_after.isdigit()
                else min(0.5 * 2**attempt, 8.0)
            )
        except URLError as error:
            last_error = error
            delay = min(0.5 * 2**attempt, 8.0)

        if attempt < attempts - 1:
            time.sleep(delay)

    raise RuntimeError(f"Failed to fetch {url}") from last_error


def request_json(url: str) -> dict[str, Any]:
    return json.loads(request_bytes(url, accept="application/json"))


def request_text(url: str, *, accept: str = "text/plain, */*") -> str:
    return request_bytes(url, accept=accept).decode("utf-8")


def download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(f"{destination.suffix}.partial")
    temporary.unlink(missing_ok=True)

    request = Request(url, headers={"User-Agent": USER_AGENT})
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            with (
                urlopen(request, timeout=60) as response,
                temporary.open("wb") as output,
            ):
                shutil.copyfileobj(response, output)
            temporary.replace(destination)
            return
        except HTTPError as error:
            last_error = error
            if error.code not in RETRY_STATUSES:
                raise
            retry_after = error.headers.get("Retry-After")
            delay = (
                min(float(retry_after), 10.0)
                if retry_after and retry_after.isdigit()
                else min(0.5 * 2**attempt, 8.0)
            )
        except URLError as error:
            last_error = error
            delay = min(0.5 * 2**attempt, 8.0)
        temporary.unlink(missing_ok=True)
        if attempt < 4:
            time.sleep(delay)

    raise RuntimeError(f"Failed to download {url}") from last_error


def polite_delay(seconds: float = 0.5) -> None:
    time.sleep(seconds)
