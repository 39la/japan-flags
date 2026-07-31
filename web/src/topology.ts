import type { GeometryCollection, Topology } from "topojson-specification";
import type { BBox, Position } from "geojson";
import type {
  MapCollection,
  MapFeature,
  MapArcGeometry,
  MapArcSource,
  MapProperties,
  TerritoryCollection,
  TerritoryGeometry,
} from "./types";

type MapTopology = Topology<{
  territories: GeometryCollection<MapProperties>;
}> & {
  metadata: MapCollection["metadata"] & {
    objectName?: "territories";
    quantization?: number;
  };
};

type PolygonArcGeometry =
  | {
      type: "Polygon";
      arcs: number[][];
      id?: string | number;
      bbox?: BBox;
      properties?: MapProperties;
    }
  | {
      type: "MultiPolygon";
      arcs: number[][][];
      id?: string | number;
      bbox?: BBox;
      properties?: MapProperties;
    };

function signedRingArea(ring: Position[]): number {
  let area = 0;
  for (let index = 0; index + 1 < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function orientRing(ring: Position[], clockwise: boolean): Position[] {
  const isClockwise = signedRingArea(ring) < 0;
  return isClockwise === clockwise ? ring : [...ring].reverse();
}

function orientPolygon(rings: Position[][]): Position[][] {
  return rings.map((ring, index) => orientRing(ring, index === 0));
}

function orientForD3(geometry: TerritoryGeometry): TerritoryGeometry {
  if (geometry.type === "Polygon") {
    return {
      ...geometry,
      coordinates: orientPolygon(geometry.coordinates),
    };
  }
  return {
    ...geometry,
    coordinates: geometry.coordinates.map(orientPolygon),
  };
}

function decodeArcs(topology: MapTopology) {
  const transform = topology.transform;
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map((position) => {
      if (transform) {
        x += position[0];
        y += position[1];
        return [
          x * transform.scale[0] + transform.translate[0],
          y * transform.scale[1] + transform.translate[1],
        ] as [number, number];
      }
      return [position[0], position[1]] as [number, number];
    });
  });
}

function stitchRing(references: number[], source: MapArcSource): Position[] {
  const ring: Position[] = [];
  for (const reference of references) {
    const arcIndex = reference < 0 ? ~reference : reference;
    const arc = source.arcs[arcIndex];
    if (!arc) {
      throw new Error(`Invalid territory arc index: ${arcIndex}`);
    }
    if (reference >= 0) {
      for (let index = ring.length ? 1 : 0; index < arc.length; index += 1) {
        ring.push(arc[index]);
      }
    } else {
      for (let index = arc.length - 1 - (ring.length ? 1 : 0); index >= 0; index -= 1) {
        ring.push(arc[index]);
      }
    }
  }
  return ring;
}

function decodeGeometry(geometry: PolygonArcGeometry, source: MapArcSource): TerritoryGeometry {
  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.arcs.map((ring) => stitchRing(ring, source)),
    };
  }
  return {
    type: "MultiPolygon",
    coordinates: geometry.arcs.map((polygon) => polygon.map((ring) => stitchRing(ring, source))),
  };
}

function arcGeometry(
  geometry: PolygonArcGeometry,
  decodedGeometry: TerritoryGeometry,
  source: MapArcSource,
): MapArcGeometry {
  const polygons = geometry.type === "Polygon" ? [geometry.arcs] : geometry.arcs;
  const coordinatePolygons =
    decodedGeometry.type === "Polygon"
      ? [decodedGeometry.coordinates]
      : decodedGeometry.coordinates;
  return {
    source,
    polygons: polygons.map((polygon, polygonIndex) =>
      polygon.map((ring, ringIndex) => {
        const coordinates = coordinatePolygons[polygonIndex]?.[ringIndex];
        if (!coordinates) return ring;
        const shouldBeClockwise = ringIndex === 0;
        const isClockwise = signedRingArea(coordinates) < 0;
        return isClockwise === shouldBeClockwise
          ? ring
          : [...ring].reverse().map((arcIndex) => ~arcIndex);
      }),
    ),
  };
}

export function decodeMapData(payload: unknown): MapCollection {
  if (
    payload &&
    typeof payload === "object" &&
    "type" in payload &&
    payload.type === "FeatureCollection"
  ) {
    return payload as MapCollection;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("type" in payload) ||
    payload.type !== "Topology" ||
    !("objects" in payload) ||
    !("metadata" in payload)
  ) {
    throw new Error("Invalid territory map payload");
  }

  const topology = payload as MapTopology;
  const object = topology.objects.territories;
  if (!object) throw new Error("Topology object 'territories' is missing");
  const source: MapArcSource = {
    key: [
      topology.metadata.mapLayer ?? "municipality",
      topology.metadata.detailLevel ?? "overview",
      topology.metadata.prefectureCode ?? "all",
    ].join(":"),
    arcs: decodeArcs(topology),
  };
  const features = object.geometries.map((current) => {
    const topologyGeometry = current as PolygonArcGeometry | undefined;
    if (topologyGeometry?.type !== "Polygon" && topologyGeometry?.type !== "MultiPolygon") {
      throw new Error("Unsupported map geometry");
    }
    const decodedGeometry = decodeGeometry(topologyGeometry, source);
    return {
      type: "Feature",
      id: topologyGeometry.id,
      bbox: topologyGeometry.bbox,
      properties: topologyGeometry.properties as MapProperties,
      geometry: orientForD3(decodedGeometry),
      arcGeometry: arcGeometry(topologyGeometry, decodedGeometry, source),
    } as MapFeature;
  });
  return {
    type: "FeatureCollection",
    bbox: topology.bbox,
    features,
    metadata: topology.metadata,
  } as MapCollection;
}

export function decodeTerritoryData(payload: unknown): TerritoryCollection {
  return decodeMapData(payload) as TerritoryCollection;
}
