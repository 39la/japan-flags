from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from .http import polite_delay, request_json, request_text

API_URL = "https://commons.wikimedia.org/w/api.php"


def _api_url(**parameters: str) -> str:
    return f"{API_URL}?{
        urlencode(
            {
                'action': 'query',
                'format': 'json',
                'formatversion': '2',
                **parameters,
            }
        )
    }"


def _list_category_members(category: str) -> list[dict[str, Any]]:
    members: list[dict[str, Any]] = []
    continuation: str | None = None

    while True:
        parameters = {
            "list": "categorymembers",
            "cmtitle": category,
            "cmtype": "file|subcat",
            "cmlimit": "max",
        }
        if continuation:
            parameters["cmcontinue"] = continuation
        response = request_json(_api_url(**parameters))
        if error := response.get("error"):
            raise RuntimeError(f"Commons API: {error['info']}")
        members.extend(response["query"]["categorymembers"])
        continuation = response.get("continue", {}).get("cmcontinue")
        if not continuation:
            return members


def fetch_category_files(
    category: str,
    *,
    recursive: bool = False,
) -> list[dict[str, Any]]:
    files: dict[str, dict[str, Any]] = {}
    visited: set[str] = set()
    queue = [category]

    while queue:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        for member in _list_category_members(current):
            if member["ns"] == 6 and member["title"].lower().endswith(".svg"):
                files[member["title"]] = {**member, "category": current}
            elif recursive and member["ns"] == 14:
                queue.append(member["title"])

    return list(files.values())


def _chunks[T](items: list[T], size: int) -> list[list[T]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def fetch_file_details(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    details: list[dict[str, Any]] = []

    for batch in _chunks(files, 20):
        pages: dict[str, dict[str, Any]] = {}
        continuation: dict[str, str] | None = None
        while True:
            parameters = {
                "prop": "imageinfo|globalusage",
                "titles": "|".join(file["title"] for file in batch),
                "iiprop": "url|mime|size|sha1|timestamp",
                "guprop": "url|pageid|namespace",
                "gunamespace": "0",
                "gulimit": "max",
                **(continuation or {}),
            }
            response = request_json(_api_url(**parameters))
            if error := response.get("error"):
                raise RuntimeError(f"Commons API: {error['info']}")
            for page in response["query"]["pages"]:
                if existing := pages.get(page["title"]):
                    existing["globalusage"].extend(page.get("globalusage", []))
                else:
                    pages[page["title"]] = {
                        **page,
                        "globalusage": page.get("globalusage", []),
                    }
            continuation = response.get("continue")
            if not continuation:
                break

        for file in batch:
            page = pages[file["title"]]
            image = page["imageinfo"][0]
            details.append(
                {
                    **file,
                    "page_id": page["pageid"],
                    "title": page["title"],
                    "category": file["category"],
                    "url": image["url"],
                    "description_url": image["descriptionurl"],
                    "mime": image["mime"],
                    "width": image["width"],
                    "height": image["height"],
                    "size": image["size"],
                    "sha1": image["sha1"],
                    "timestamp": image["timestamp"],
                    "global_usage": page["globalusage"],
                }
            )

    return details


def fetch_global_usage(
    files: list[dict[str, Any]],
) -> dict[int, list[dict[str, Any]]]:
    usages_by_page: dict[int, list[dict[str, Any]]] = {
        int(file["page_id"]): [] for file in files
    }
    for batch in _chunks(files, 40):
        continuation: dict[str, str] | None = None
        while True:
            response = request_json(
                _api_url(
                    prop="globalusage",
                    pageids="|".join(str(file["page_id"]) for file in batch),
                    guprop="url|pageid|namespace",
                    gunamespace="0",
                    gulimit="max",
                    **(continuation or {}),
                )
            )
            if error := response.get("error"):
                raise RuntimeError(f"Commons API: {error['info']}")
            for page in response["query"]["pages"]:
                page_id = int(page["pageid"])
                usages_by_page[page_id].extend(
                    {
                        "wiki": usage["wiki"],
                        "title": usage["title"],
                        "url": usage.get("url"),
                        "ns": int(usage.get("ns", usage.get("namespace", 0))),
                    }
                    for usage in page.get("globalusage", [])
                )
            continuation = response.get("continue")
            if not continuation:
                break
    return usages_by_page


def acquire_commons_data(
    *,
    category: str,
    raw_directory: Path,
    asset_directory: Path,
    refresh: bool = False,
    recursive: bool = False,
) -> dict[str, Any]:
    raw_directory.mkdir(parents=True, exist_ok=True)
    asset_directory.mkdir(parents=True, exist_ok=True)
    cache_name = re.sub(r"[^a-zA-Z0-9]+", "_", category)
    cache_path = raw_directory / f"{cache_name}.json"

    if not refresh and cache_path.exists():
        cached = json.loads(cache_path.read_text())
        try:
            for file in cached["files"]:
                local_path = asset_directory / f"{file['page_id']}.svg"
                file["svg_text"] = local_path.read_text()
                file["local_path"] = str(local_path)
        except OSError:
            pass
        else:
            return {**cached, "cache_hit": True}

    members = fetch_category_files(category, recursive=recursive)
    details = fetch_file_details(members)
    acquired_at = datetime.now(UTC).isoformat()
    files: list[dict[str, Any]] = []
    download_count = 0

    for detail in details:
        local_path = asset_directory / f"{detail['page_id']}.svg"
        if not refresh and local_path.exists():
            svg_text = local_path.read_text()
        else:
            if download_count:
                polite_delay()
            svg_text = request_text(
                detail["url"],
                accept="image/svg+xml, text/xml, */*",
            )
            local_path.write_text(svg_text)
            download_count += 1
            print(f"  downloaded SVG {download_count}: {detail['title']}", flush=True)
        files.append(
            {
                **detail,
                "svg_text": svg_text,
                "local_path": str(local_path),
            }
        )

    snapshot = {
        "category": category,
        "acquired_at": acquired_at,
        "recursive": recursive,
        "files": [
            {
                key: value
                for key, value in file.items()
                if key not in {"svg_text", "local_path"}
            }
            for file in files
        ],
    }
    cache_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")
    return {**snapshot, "files": files, "cache_hit": False}
