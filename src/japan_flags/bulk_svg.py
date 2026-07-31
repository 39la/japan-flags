from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .commons import _api_url, _list_category_members
from .http import request_bytes, request_json
from .known_current_flags import add_known_current_flags

DEFAULT_ROOT = "Category:SVG flags of municipalities in Japan"


def crawl_svg_tree(root_category: str) -> dict[str, Any]:
    queue = [(root_category, 0)]
    visited: set[str] = set()
    category_edges: list[dict[str, str]] = []
    files: dict[str, dict[str, Any]] = {}

    while queue:
        category, depth = queue.pop(0)
        if category in visited:
            continue
        visited.add(category)

        for member in _list_category_members(category):
            if member["ns"] == 6 and member["title"].lower().endswith(".svg"):
                file = files.setdefault(
                    member["title"],
                    {
                        "page_id": member["pageid"],
                        "title": member["title"],
                        "categories": [],
                    },
                )
                if category not in file["categories"]:
                    file["categories"].append(category)
            elif member["ns"] == 14:
                child = member["title"]
                category_edges.append({"parent": category, "child": child})
                if child not in visited:
                    queue.append((child, depth + 1))

        if len(visited) == 1 or len(visited) % 10 == 0:
            print(
                f"  crawled {len(visited)} categories, found {len(files)} unique SVGs",
                flush=True,
            )

    return {
        "root_category": root_category,
        "categories": sorted(visited),
        "category_edges": category_edges,
        "files": sorted(files.values(), key=lambda file: file["page_id"]),
    }


def fetch_basic_file_details(
    files: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    details: list[dict[str, Any]] = []
    batch_size = 20
    batch_count = (len(files) + batch_size - 1) // batch_size

    for batch_index, start in enumerate(range(0, len(files), batch_size), 1):
        batch = files[start : start + batch_size]
        response = request_json(
            _api_url(
                prop="imageinfo",
                titles="|".join(file["title"] for file in batch),
                iiprop="url|mime|size|sha1|timestamp",
            )
        )
        pages = {page["title"]: page for page in response["query"]["pages"]}
        for file in batch:
            page = pages[file["title"]]
            image = page["imageinfo"][0]
            details.append(
                {
                    **file,
                    "page_id": page["pageid"],
                    "url": image["url"],
                    "description_url": image["descriptionurl"],
                    "mime": image["mime"],
                    "width": image["width"],
                    "height": image["height"],
                    "size": image["size"],
                    "sha1": image["sha1"],
                    "timestamp": image["timestamp"],
                }
            )
        if batch_index == 1 or batch_index % 10 == 0 or batch_index == batch_count:
            print(
                f"  metadata batches {batch_index}/{batch_count}",
                flush=True,
            )

    return details


def _sha1_hex(content: bytes) -> str:
    return hashlib.sha1(content).hexdigest()


def download_svg_file(
    file: dict[str, Any],
    asset_directory: Path,
    refresh: bool,
) -> str:
    path = asset_directory / f"{file['page_id']}.svg"
    if path.exists() and not refresh:
        content = path.read_bytes()
        if len(content) == file["size"] and _sha1_hex(content) == file["sha1"]:
            return "cached"

    content = request_bytes(
        file["url"],
        accept="image/svg+xml, text/xml, */*",
    )
    if len(content) != file["size"]:
        raise ValueError(
            f"Size mismatch for {file['title']}: {len(content)} != {file['size']}"
        )
    actual_sha1 = _sha1_hex(content)
    if actual_sha1 != file["sha1"]:
        raise ValueError(
            f"SHA1 mismatch for {file['title']}: {actual_sha1} != {file['sha1']}"
        )

    temporary = path.with_suffix(".svg.partial")
    temporary.write_bytes(content)
    temporary.replace(path)
    return "downloaded"


def acquire_all_svg(
    *,
    root_category: str,
    raw_directory: Path,
    asset_directory: Path,
    workers: int = 8,
    refresh: bool = False,
) -> dict[str, Any]:
    raw_directory.mkdir(parents=True, exist_ok=True)
    asset_directory.mkdir(parents=True, exist_ok=True)
    manifest_path = raw_directory / "all-municipal-svg-manifest.json"

    if manifest_path.exists() and not refresh:
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("root_category") != root_category:
            raise ValueError(
                "Cached manifest root differs; use --refresh to replace it"
            )
        print(
            f"  loaded manifest with {len(manifest['files'])} SVGs",
            flush=True,
        )
    else:
        inventory = crawl_svg_tree(root_category)
        supplement_count = add_known_current_flags(inventory)
        if supplement_count:
            print(
                f"  added {supplement_count} known current SVG supplements",
                flush=True,
            )
        inventory["files"] = fetch_basic_file_details(inventory["files"])
        inventory["files"].sort(key=lambda file: file["page_id"])
        manifest = {
            **inventory,
            "inventory_at": datetime.now(UTC).isoformat(),
        }
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
        )

    downloaded = 0
    cached = 0
    failures: list[dict[str, str]] = []
    total = len(manifest["files"])
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                download_svg_file,
                file,
                asset_directory,
                refresh,
            ): file
            for file in manifest["files"]
        }
        for completed, future in enumerate(as_completed(futures), 1):
            file = futures[future]
            try:
                status = future.result()
                if status == "downloaded":
                    downloaded += 1
                else:
                    cached += 1
            except Exception as error:
                failures.append(
                    {
                        "page_id": str(file["page_id"]),
                        "title": file["title"],
                        "error": str(error),
                    }
                )
            if completed == 1 or completed % 100 == 0 or completed == total:
                print(
                    f"  files {completed}/{total} "
                    f"(downloaded={downloaded}, cached={cached}, "
                    f"failed={len(failures)})",
                    flush=True,
                )

    result = {
        "root_category": root_category,
        "manifest_path": str(manifest_path),
        "asset_directory": str(asset_directory),
        "total": total,
        "downloaded": downloaded,
        "cached": cached,
        "failed": len(failures),
        "failures": failures,
        "finished_at": datetime.now(UTC).isoformat(),
    }
    result_path = raw_directory / "all-municipal-svg-result.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")

    if failures:
        raise RuntimeError(
            f"{len(failures)} SVG downloads failed; rerun to resume. See {result_path}"
        )
    return result
