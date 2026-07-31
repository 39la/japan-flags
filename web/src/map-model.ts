import { geoMercator, geoPath, type GeoPath, type GeoProjection } from "d3-geo";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { MapFeature, TerritoryGeometry } from "./types";

export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 760;

const nationalExtent: [[number, number], [number, number]] = [
  [42, 26],
  [958, 734],
];

function collection(features: MapFeature[]): FeatureCollection<TerritoryGeometry> {
  return {
    type: "FeatureCollection",
    features: features as FeatureCollection<TerritoryGeometry>["features"],
  };
}

type MapRenderer = {
  features: MapFeature[];
  projection: GeoProjection;
  path: GeoPath;
};

export function buildMapProjection(features: MapFeature[]) {
  if (!features.length) return null;
  const featureBounds = features.map((feature) => feature.bbox);
  if (
    featureBounds.every(
      (bounds): bounds is [number, number, number, number] => bounds?.length === 4,
    )
  ) {
    const [minLongitude, minLatitude, maxLongitude, maxLatitude] = featureBounds.reduce<
      [number, number, number, number]
    >(
      (current, bounds) => [
        Math.min(current[0], bounds[0]),
        Math.min(current[1], bounds[1]),
        Math.max(current[2], bounds[2]),
        Math.max(current[3], bounds[3]),
      ],
      [
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ],
    );
    const boundsFeature: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [minLongitude, minLatitude],
            [minLongitude, maxLatitude],
            [maxLongitude, maxLatitude],
            [maxLongitude, minLatitude],
            [minLongitude, minLatitude],
          ],
        ],
      },
    };
    return geoMercator().fitExtent(nationalExtent, boundsFeature);
  }
  return geoMercator().fitExtent(nationalExtent, collection(features));
}

export function buildMapRenderer(
  features: MapFeature[],
  projection = buildMapProjection(features),
): MapRenderer | null {
  if (!features.length || !projection) return null;
  return {
    features,
    projection,
    path: geoPath(projection),
  };
}

export function focusBounds(
  bounds: [[number, number], [number, number]],
  maxZoom = 8,
  fill = 0.55,
): { x: number; y: number; k: number } {
  const [[x0, y0], [x1, y1]] = bounds;
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const k = Math.min(maxZoom, fill / Math.max(width / MAP_WIDTH, height / MAP_HEIGHT));
  return {
    x: MAP_WIDTH / 2 - (k * (x0 + x1)) / 2,
    y: MAP_HEIGHT / 2 - (k * (y0 + y1)) / 2,
    k,
  };
}
