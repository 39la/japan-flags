from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator
from zipfile import ZipFile

from .http import download_file


def n03_url(*, prefecture_code: str, n03_date: str) -> str:
    year = n03_date[:4]
    filename = f"N03-{n03_date}_{prefecture_code}_GML.zip"
    return f"https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-{year}/{filename}"


def _geometry_polygons(geometry: dict[str, Any] | None) -> list[Any]:
    if not geometry:
        return []
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    raise ValueError(f"Unsupported N03 geometry type: {geometry['type']}")


def _positions(coordinates: Any) -> Iterator[tuple[float, float]]:
    if (
        isinstance(coordinates, list)
        and len(coordinates) >= 2
        and isinstance(coordinates[0], (int, float))
        and isinstance(coordinates[1], (int, float))
    ):
        yield float(coordinates[0]), float(coordinates[1])
        return
    for child in coordinates or []:
        yield from _positions(child)


def _bbox(coordinates: Any) -> list[float]:
    points = _positions(coordinates)
    first_lng, first_lat = next(points)
    bounds = [first_lng, first_lat, first_lng, first_lat]
    for longitude, latitude in points:
        bounds[0] = min(bounds[0], longitude)
        bounds[1] = min(bounds[1], latitude)
        bounds[2] = max(bounds[2], longitude)
        bounds[3] = max(bounds[3], latitude)
    return bounds


def aggregate_n03(
    geojson: dict[str, Any],
    boundary_date: str,
) -> list[dict[str, Any]]:
    areas: dict[str, dict[str, Any]] = {}

    for feature in geojson["features"]:
        properties = feature.get("properties") or {}
        jis5 = str(properties.get("N03_007") or "").zfill(5)
        if len(jis5) != 5 or not jis5.isdigit():
            continue
        area = areas.setdefault(
            jis5,
            {
                "jis5": jis5,
                "prefecture_code": jis5[:2],
                "prefecture_name": properties.get("N03_001"),
                "subprefecture_name": properties.get("N03_002"),
                "district_name": properties.get("N03_003"),
                "municipality_name": properties.get("N03_004"),
                "ward_name": properties.get("N03_005"),
                "display_name": (
                    properties.get("N03_005") or properties.get("N03_004")
                ),
                "boundary_date": boundary_date,
                "feature_count": 0,
                "polygons": [],
            },
        )
        area["feature_count"] += 1
        area["polygons"].extend(_geometry_polygons(feature.get("geometry")))

    result = []
    for area in areas.values():
        polygons = area.pop("polygons")
        result.append(
            {
                **area,
                "geometry": {"type": "MultiPolygon", "coordinates": polygons},
                "bbox": _bbox(polygons),
            }
        )
    return result


def acquire_n03_data(
    *,
    prefecture_code: str,
    n03_date: str,
    raw_directory: Path,
    refresh: bool = False,
) -> dict[str, Any]:
    raw_directory.mkdir(parents=True, exist_ok=True)
    url = n03_url(prefecture_code=prefecture_code, n03_date=n03_date)
    zip_path = raw_directory / Path(url).name
    cache_hit = zip_path.exists() and not refresh
    if not cache_hit:
        download_file(url, zip_path)

    with ZipFile(zip_path) as archive:
        geojson_name = next(
            name for name in archive.namelist() if name.lower().endswith(".geojson")
        )
        geojson = json.loads(archive.read(geojson_name))

    return {
        "url": url,
        "zip_path": str(zip_path),
        "cache_hit": cache_hit,
        "feature_count": len(geojson["features"]),
        "areas": aggregate_n03(geojson, n03_date),
    }
