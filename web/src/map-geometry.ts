import { yieldToBrowser } from "./browser-scheduling";
import { geoPath, type GeoContext, type GeoPath, type GeoProjection } from "d3-geo";
import earcut from "earcut";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { buildMapProjection, buildMapRenderer } from "./map-model";
import { featureKey } from "./render-plan";
import type { MapFeature, MapArcGeometry, MapArcSource, MapLayer } from "./types";

export type RenderedFeature = {
  feature: MapFeature;
  canvasPath: Path2D | null;
  webglMesh?: WebGLFeatureMesh | null;
  bounds: [[number, number], [number, number]];
  key?: string;
};

export type WebGLMeshChunk = {
  bounds: [[number, number], [number, number]];
  indexCount: number;
};

export type WebGLFeatureMesh = {
  vertices: Float32Array;
  indices: Uint32Array;
  chunks: WebGLMeshChunk[];
};

export type RenderedBoundaryChunk = {
  canvasPath: Path2D | null;
  bounds: [[number, number], [number, number]];
  vertexCount: number;
};

export type RenderedBoundary = {
  source: BoundaryArcSet;
  chunks: RenderedBoundaryChunk[];
  webglLines?: Float32Array;
  bounds: [[number, number], [number, number]];
  pointCount: number;
};

export type RenderedFeatureCache = WeakMap<
  MapFeature,
  {
    projection: GeoProjection;
    item: RenderedFeature;
  }
>;

type RenderedFeatureCompiler = {
  compiled: boolean;
  next: () => RenderedFeature | null;
};

type RenderedBoundaryCompiler = {
  compiled: boolean;
  next: () => RenderedBoundary | null;
};

type CompiledMapScene = {
  generation: number;
  layer: MapLayer | null;
  source: MapFeature[] | null;
  renderedFeatures: RenderedFeature[];
  renderedBoundaries: RenderedBoundary[];
};

const GEOMETRY_COMPILE_SLICE_MS = 8;
const EMPTY_RENDERED_FEATURES: RenderedFeature[] = [];
const EMPTY_RENDERED_BOUNDARIES: RenderedBoundary[] = [];
const MAX_BOUNDARY_PATH_POINTS = 4096;
const MAX_COMPILE_POINTS = 2048;
const MAX_BOUNDARY_CACHE_ENTRIES_PER_SOURCE = 4;
let boundaryCacheClock = 0;

function projectedFeatureBounds(feature: MapFeature, projection: GeoProjection, path: GeoPath) {
  const bbox = feature.bbox;
  if (!bbox || bbox.length !== 4) {
    return path.bounds(feature) as [[number, number], [number, number]];
  }
  const [minLongitude, minLatitude, maxLongitude, maxLatitude] = bbox;
  const projected = [
    projection([minLongitude, minLatitude]),
    projection([minLongitude, maxLatitude]),
    projection([maxLongitude, minLatitude]),
    projection([maxLongitude, maxLatitude]),
  ].filter((point): point is [number, number] => point !== null);
  if (!projected.length) {
    return path.bounds(feature) as [[number, number], [number, number]];
  }
  const bounds = projected.reduce<[[number, number], [number, number]]>(
    (current, [x, y]) => [
      [Math.min(current[0][0], x), Math.min(current[0][1], y)],
      [Math.max(current[1][0], x), Math.max(current[1][1], y)],
    ],
    [
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    ],
  );
  const padding = 0.5;
  return [
    [bounds[0][0] - padding, bounds[0][1] - padding],
    [bounds[1][0] + padding, bounds[1][1] + padding],
  ] as [[number, number], [number, number]];
}

type ProjectedPoint = [number, number];

function samePoint(left: ProjectedPoint, right: ProjectedPoint) {
  return left[0] === right[0] && left[1] === right[1];
}

function closeProjectedRing(points: ProjectedPoint[]) {
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) {
    points.pop();
  }
  return points.length >= 3 ? points : null;
}

export type BoundaryArcSet = {
  key: string;
  prefectureCode: string;
  source: MapArcSource;
  arcIndexes: number[];
};

export type BoundarySourceGroup = {
  source: MapArcSource;
  signature: string;
  arcSets: BoundaryArcSet[];
};

type BoundaryCacheEntry = {
  signature: string;
  items: RenderedBoundary[];
  lastUsed: number;
};

export type RenderedBoundaryCache = WeakMap<
  MapArcSource,
  WeakMap<GeoProjection, BoundaryCacheEntry[]>
>;

export type ProjectedArcStore = {
  get: (arcIndex: number) => ProjectedPoint[];
  projectedArcCount: () => number;
  projectedPointCount: () => number;
};

const projectedArcStores = new WeakMap<MapArcSource, WeakMap<GeoProjection, ProjectedArcStore>>();

function featureArcGeometry(feature: MapFeature): MapArcGeometry | null {
  return feature.arcGeometry ?? null;
}

function absoluteArcIndex(arcIndex: number) {
  return arcIndex < 0 ? ~arcIndex : arcIndex;
}

export function createProjectedArcStore(
  source: MapArcSource,
  projection: GeoProjection,
): ProjectedArcStore {
  const cached = projectedArcStores.get(source)?.get(projection);
  if (cached) return cached;
  const projectedArcs = new Array<ProjectedPoint[] | undefined>(source.arcs.length);
  let projectedArcCount = 0;
  let projectedPointCount = 0;
  const store: ProjectedArcStore = {
    get: (arcIndex) => {
      const normalizedIndex = absoluteArcIndex(arcIndex);
      const existing = projectedArcs[normalizedIndex];
      if (existing) return existing;
      const arc = source.arcs[normalizedIndex];
      if (!arc) {
        throw new Error(`Invalid projected arc index: ${normalizedIndex}`);
      }
      const projected: ProjectedPoint[] = [];
      for (const position of arc) {
        const point = projection([position[0], position[1]]);
        if (point) projected.push(point);
      }
      projectedArcs[normalizedIndex] = projected;
      projectedArcCount += 1;
      projectedPointCount += projected.length;
      return projected;
    },
    projectedArcCount: () => projectedArcCount,
    projectedPointCount: () => projectedPointCount,
  };
  let byProjection = projectedArcStores.get(source);
  if (!byProjection) {
    byProjection = new WeakMap();
    projectedArcStores.set(source, byProjection);
  }
  byProjection.set(projection, store);
  return store;
}

function projectedTopologyRings(feature: MapFeature, projection: GeoProjection) {
  const geometry = feature.arcGeometry;
  if (!geometry) return null;
  const store = createProjectedArcStore(geometry.source, projection);
  return geometry.polygons
    .map((polygon) =>
      polygon
        .map((ring) => {
          const points: ProjectedPoint[] = [];
          for (const reference of ring) {
            const arc = store.get(reference);
            const ordered = reference >= 0 ? arc : [...arc].reverse();
            for (let index = 0; index < ordered.length; index += 1) {
              if (points.length && index === 0) continue;
              points.push(ordered[index]);
            }
          }
          return closeProjectedRing(points);
        })
        .filter((ring): ring is ProjectedPoint[] => ring !== null),
    )
    .filter((polygon) => polygon.length > 0);
}

function projectedGeoJsonRings(feature: MapFeature, projection: GeoProjection) {
  const projectRing = (coordinates: number[][]) =>
    closeProjectedRing(
      coordinates
        .map(([longitude, latitude]) => projection([longitude, latitude]))
        .filter((point): point is ProjectedPoint => point !== null),
    );
  if (feature.geometry.type === "Polygon") {
    return [feature.geometry.coordinates.map(projectRing).filter(isProjectedRing)];
  }
  return feature.geometry.coordinates.map((polygon) =>
    polygon.map(projectRing).filter(isProjectedRing),
  );
}

function isProjectedRing(ring: ProjectedPoint[] | null): ring is ProjectedPoint[] {
  return ring !== null;
}

export function buildWebGLFeatureMesh(
  feature: MapFeature,
  projection: GeoProjection,
): WebGLFeatureMesh | null {
  const polygons = feature.arcGeometry
    ? projectedTopologyRings(feature, projection)
    : projectedGeoJsonRings(feature, projection);
  if (!polygons) return null;

  const vertices: number[] = [];
  const indices: number[] = [];
  const chunks: WebGLMeshChunk[] = [];
  for (const polygon of polygons) {
    if (!polygon.length || !polygon[0]) continue;
    const flat: number[] = [];
    const holes: number[] = [];
    for (const ring of polygon) {
      if (flat.length) holes.push(flat.length / 2);
      for (const [x, y] of ring) flat.push(x, y);
    }
    if (flat.length < 6) continue;
    const triangles = earcut(flat, holes, 2);
    const vertexOffset = vertices.length / 2;
    const bounds: WebGLMeshChunk["bounds"] = [
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    ];
    for (let offset = 0; offset < flat.length; offset += 2) {
      const x = flat[offset];
      const y = flat[offset + 1];
      vertices.push(x, y);
      bounds[0][0] = Math.min(bounds[0][0], x);
      bounds[0][1] = Math.min(bounds[0][1], y);
      bounds[1][0] = Math.max(bounds[1][0], x);
      bounds[1][1] = Math.max(bounds[1][1], y);
    }
    for (const index of triangles) indices.push(vertexOffset + index);
    if (triangles.length) chunks.push({ bounds, indexCount: triangles.length });
  }
  if (!indices.length) return null;
  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    chunks,
  };
}

function mapFeatureSignature(feature: MapFeature) {
  return feature.properties.entityType === "prefecture"
    ? `prefecture:${feature.properties.prefectureVersionId}:${feature.properties.mapPart}`
    : `territory:${feature.properties.territoryVersionId}`;
}

function collectBoundarySourceGroups(features: MapFeature[]): BoundarySourceGroup[] {
  const prefectureLayer = features.every(
    (feature) => feature.properties.entityType === "prefecture",
  );
  const ownersBySource = new Map<MapArcSource, Map<number, Set<string>>>();
  const usageBySource = new Map<MapArcSource, Map<number, number>>();
  const featureKeysBySource = new Map<MapArcSource, string[]>();
  for (const feature of features) {
    const geometry = featureArcGeometry(feature);
    if (!geometry) continue;
    const prefectureCode =
      "jis5" in feature.properties
        ? (feature.properties.prefectureCode ?? feature.properties.jis5.slice(0, 2))
        : feature.properties.prefectureCode;
    let owners = ownersBySource.get(geometry.source);
    if (!owners) {
      owners = new Map();
      ownersBySource.set(geometry.source, owners);
    }
    let usage = usageBySource.get(geometry.source);
    if (!usage) {
      usage = new Map();
      usageBySource.set(geometry.source, usage);
    }
    const sourceFeatureKeys = featureKeysBySource.get(geometry.source) ?? [];
    sourceFeatureKeys.push(mapFeatureSignature(feature));
    featureKeysBySource.set(geometry.source, sourceFeatureKeys);
    for (const polygon of geometry.polygons) {
      for (const ring of polygon) {
        for (const reference of ring) {
          const arcIndex = absoluteArcIndex(reference);
          const arcOwners = owners.get(arcIndex) ?? new Set<string>();
          arcOwners.add(prefectureCode);
          owners.set(arcIndex, arcOwners);
          usage.set(arcIndex, (usage.get(arcIndex) ?? 0) + 1);
        }
      }
    }
  }
  const result: BoundarySourceGroup[] = [];
  for (const [source, owners] of ownersBySource) {
    const usage = usageBySource.get(source) ?? new Map();
    const indexesByPrefecture = new Map<string, number[]>();
    for (const [arcIndex, arcOwners] of owners) {
      if (prefectureLayer && (usage.get(arcIndex) ?? 0) > 1 && arcOwners.size === 1) {
        continue;
      }
      const prefectureCode = [...arcOwners].sort()[0];
      const indexes = indexesByPrefecture.get(prefectureCode) ?? [];
      indexes.push(arcIndex);
      indexesByPrefecture.set(prefectureCode, indexes);
    }
    const arcSets = [...indexesByPrefecture]
      .map(([prefectureCode, arcIndexes]) => ({
        key: `${source.key}:${prefectureCode}`,
        prefectureCode,
        source,
        arcIndexes: arcIndexes.sort((left, right) => left - right),
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
    result.push({
      source,
      signature: (featureKeysBySource.get(source) ?? []).sort().join(","),
      arcSets,
    });
  }
  return result.sort((left, right) => left.source.key.localeCompare(right.source.key));
}

export function collectBoundaryArcSets(features: MapFeature[]): BoundaryArcSet[] {
  return collectBoundarySourceGroups(features).flatMap((group) => group.arcSets);
}

export function cachedRenderedBoundaries(
  cache: RenderedBoundaryCache,
  group: BoundarySourceGroup,
  projection: GeoProjection,
) {
  const entries = cache.get(group.source)?.get(projection);
  const cached = entries?.find((entry) => entry.signature === group.signature);
  if (!cached) return null;
  boundaryCacheClock += 1;
  cached.lastUsed = boundaryCacheClock;
  return cached.items;
}

export function cacheRenderedBoundaries(
  cache: RenderedBoundaryCache,
  group: BoundarySourceGroup,
  projection: GeoProjection,
  items: RenderedBoundary[],
) {
  let byProjection = cache.get(group.source);
  if (!byProjection) {
    byProjection = new WeakMap();
    cache.set(group.source, byProjection);
  }
  const entries = byProjection.get(projection) ?? [];
  const retained = entries.filter((entry) => entry.signature !== group.signature);
  retained.push({
    signature: group.signature,
    items,
    lastUsed: ++boundaryCacheClock,
  });
  retained.sort((left, right) => right.lastUsed - left.lastUsed);
  byProjection.set(projection, retained.slice(0, MAX_BOUNDARY_CACHE_ENTRIES_PER_SOURCE));
}

export function createRenderedBoundaryCompiler(
  source: BoundaryArcSet,
  projection: GeoProjection,
): RenderedBoundaryCompiler {
  const store = createProjectedArcStore(source.source, projection);
  const chunks: RenderedBoundaryChunk[] = [];
  const webglLines: number[] = [];
  let activeChunk: RenderedBoundaryChunk | null = null;
  let activePointCount = 0;
  let arcIndex = 0;
  let pointIndex = 0;
  let pointCount = 0;
  let completed: RenderedBoundary | null = null;
  const extendBounds = (bounds: RenderedBoundary["bounds"], [x, y]: ProjectedPoint) => {
    bounds[0][0] = Math.min(bounds[0][0], x);
    bounds[0][1] = Math.min(bounds[0][1], y);
    bounds[1][0] = Math.max(bounds[1][0], x);
    bounds[1][1] = Math.max(bounds[1][1], y);
  };
  const finish = () => {
    const bounds: RenderedBoundary["bounds"] = chunks.length
      ? [
          [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
          [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
        ]
      : [
          [0, 0],
          [0, 0],
        ];
    for (const chunk of chunks) {
      extendBounds(bounds, chunk.bounds[0]);
      extendBounds(bounds, chunk.bounds[1]);
    }
    completed = {
      source,
      chunks,
      webglLines: new Float32Array(webglLines),
      bounds,
      pointCount,
    };
    return completed;
  };
  return {
    compiled: true,
    next: () => {
      if (completed) return completed;
      if (!source.arcIndexes.length) return finish();
      let processed = 0;
      while (arcIndex < source.arcIndexes.length && processed < MAX_COMPILE_POINTS) {
        const points = store.get(source.arcIndexes[arcIndex]);
        if (pointIndex >= points.length) {
          arcIndex += 1;
          pointIndex = 0;
          continue;
        }
        const point = points[pointIndex];
        const previous = pointIndex > 0 ? points[pointIndex - 1] : null;
        if (!activeChunk || activePointCount >= MAX_BOUNDARY_PATH_POINTS) {
          activeChunk = {
            canvasPath: typeof Path2D === "undefined" ? null : new Path2D(),
            bounds: [
              [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
              [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
            ],
            vertexCount: 0,
          };
          chunks.push(activeChunk);
          activePointCount = 0;
          if (previous) {
            // 分割点の直前の点を含め、CanvasとGPUの両方で線分を欠かさない。
            activeChunk.canvasPath?.moveTo(previous[0], previous[1]);
            extendBounds(activeChunk.bounds, previous);
          }
        }
        if (previous) {
          webglLines.push(previous[0], previous[1], point[0], point[1]);
          activeChunk.vertexCount += 2;
          activeChunk.canvasPath?.lineTo(point[0], point[1]);
        } else if (points.length >= 2) {
          activeChunk.canvasPath?.moveTo(point[0], point[1]);
        }
        extendBounds(activeChunk.bounds, point);
        activePointCount += 1;
        pointIndex += 1;
        pointCount += 1;
        processed += 1;
      }
      return arcIndex === source.arcIndexes.length ? finish() : null;
    },
  };
}

export function createRenderedFeatureCompiler(
  feature: MapFeature,
  path: GeoPath,
  projection: GeoProjection,
  cache: RenderedFeatureCache,
): RenderedFeatureCompiler {
  const cached = cache.get(feature);
  if (cached?.projection === projection) {
    return {
      compiled: false,
      next: () => cached.item,
    };
  }
  const canvasPath = typeof Path2D === "undefined" ? null : new Path2D();
  const topologyGeometry = featureArcGeometry(feature);
  const topologyRings = topologyGeometry
    ? topologyGeometry.polygons.flatMap((polygon) => polygon)
    : null;
  const projectedStore = topologyGeometry
    ? createProjectedArcStore(topologyGeometry.source, projection)
    : null;
  const canvasRenderer =
    canvasPath && !topologyGeometry
      ? geoPath(projection, canvasPath as unknown as GeoContext)
      : null;
  const geometries =
    feature.geometry.type === "MultiPolygon"
      ? feature.geometry.coordinates.map((coordinates) => ({
          type: "Polygon" as const,
          coordinates,
        }))
      : [feature.geometry];
  let geometryIndex = 0;
  let ringArcIndex = 0;
  let ringPointIndex = 0;
  let ringStarted = false;
  let completed: RenderedFeature | null = null;
  const finish = () => {
    const item: RenderedFeature = {
      feature,
      canvasPath,
      webglMesh: buildWebGLFeatureMesh(feature, projection),
      bounds: projectedFeatureBounds(feature, projection, path),
      key: featureKey(feature),
    };
    cache.set(feature, { projection, item });
    completed = item;
    return item;
  };
  return {
    compiled: true,
    next: () => {
      if (completed) return completed;
      if (canvasPath && topologyRings && projectedStore) {
        if (!topologyRings.length) return finish();
        let processed = 0;
        while (geometryIndex < topologyRings.length && processed < MAX_COMPILE_POINTS) {
          const ring = topologyRings[geometryIndex];
          if (ringArcIndex >= ring.length) {
            if (ringStarted) canvasPath.closePath();
            geometryIndex += 1;
            ringArcIndex = 0;
            ringPointIndex = 0;
            ringStarted = false;
            continue;
          }
          const arcIndex = ring[ringArcIndex];
          const points = projectedStore.get(arcIndex);
          if (ringPointIndex >= points.length) {
            ringArcIndex += 1;
            ringPointIndex = 0;
            continue;
          }
          const sourceIndex = arcIndex >= 0 ? ringPointIndex : points.length - 1 - ringPointIndex;
          const [x, y] = points[sourceIndex];
          if (!(ringStarted && ringPointIndex === 0)) {
            if (!ringStarted) {
              canvasPath.moveTo(x, y);
              ringStarted = true;
            } else {
              canvasPath.lineTo(x, y);
            }
          }
          ringPointIndex += 1;
          processed += 1;
        }
        return geometryIndex === topologyRings.length ? finish() : null;
      }
      if (!canvasRenderer || !geometries.length) return finish();
      canvasRenderer(geometries[geometryIndex]);
      geometryIndex += 1;
      return geometryIndex === geometries.length ? finish() : null;
    },
  };
}

export function useCompiledMapScene(
  features: MapFeature[],
  layer: MapLayer,
  sharedProjection: GeoProjection | null = null,
  compileFeatures = true,
) {
  const projectionRef = useRef<NonNullable<ReturnType<typeof buildMapProjection>> | null>(null);
  const featureCacheRef = useRef<RenderedFeatureCache>(new WeakMap());
  const boundaryCacheRef = useRef<RenderedBoundaryCache>(new WeakMap());
  const compileGenerationRef = useRef(0);
  const [compiledScene, setCompiledScene] = useState<CompiledMapScene>({
    generation: 0,
    layer: null,
    source: null,
    renderedFeatures: [],
    renderedBoundaries: [],
  });
  const projection = useMemo(() => {
    if (sharedProjection) return sharedProjection;
    if (projectionRef.current) return projectionRef.current;
    const created = buildMapProjection(features);
    if (created) projectionRef.current = created;
    return created;
  }, [features, sharedProjection]);
  const renderer = useMemo(
    () => (projection ? buildMapRenderer(features, projection) : null),
    [features, projection],
  );

  useEffect(() => {
    const generation = compileGenerationRef.current + 1;
    compileGenerationRef.current = generation;
    const cache = featureCacheRef.current;
    if (!renderer) {
      setCompiledScene({
        generation,
        layer,
        source: features,
        renderedFeatures: [],
        renderedBoundaries: [],
      });
      return;
    }
    let cancelled = false;
    const featureCompilers = compileFeatures
      ? renderer.features.map((feature) => ({
          compiler: createRenderedFeatureCompiler(
            feature,
            renderer.path,
            renderer.projection,
            cache,
          ),
        }))
      : [];
    const boundaryGroups = collectBoundarySourceGroups(features);
    const boundaryTasks = boundaryGroups.map((group) => {
      const cached = cachedRenderedBoundaries(boundaryCacheRef.current, group, renderer.projection);
      if (cached) {
        return { group, cached, compilers: null };
      }
      return {
        group,
        cached: null,
        compilers: group.arcSets.map((source) =>
          createRenderedBoundaryCompiler(source, renderer.projection),
        ),
      };
    });
    const renderedFeatureItems: RenderedFeature[] = [];
    const renderedBoundaryItems: RenderedBoundary[] = [];
    const compile = async () => {
      let featureIndex = 0;
      let boundaryTaskIndex = 0;
      let boundaryCompilerIndex = 0;
      let activeBoundaryItems: RenderedBoundary[] = [];
      const hasPendingWork = () =>
        featureIndex < featureCompilers.length || boundaryTaskIndex < boundaryTasks.length;
      while (hasPendingWork() && !cancelled && compileGenerationRef.current === generation) {
        const sliceStart = performance.now();
        const sliceDeadline = sliceStart + GEOMETRY_COMPILE_SLICE_MS;
        do {
          if (featureIndex < featureCompilers.length) {
            const current = featureCompilers[featureIndex];
            const item = current.compiler.next();
            if (!item) continue;
            renderedFeatureItems.push(item);
            featureIndex += 1;
            continue;
          }
          const task = boundaryTasks[boundaryTaskIndex];
          if (task.cached) {
            renderedBoundaryItems.push(...task.cached);
            boundaryTaskIndex += 1;
            continue;
          }
          const compiler = task.compilers?.[boundaryCompilerIndex];
          if (!compiler) {
            cacheRenderedBoundaries(
              boundaryCacheRef.current,
              task.group,
              renderer.projection,
              activeBoundaryItems,
            );
            renderedBoundaryItems.push(...activeBoundaryItems);
            activeBoundaryItems = [];
            boundaryCompilerIndex = 0;
            boundaryTaskIndex += 1;
            continue;
          }
          const boundary = compiler.next();
          if (boundary) {
            activeBoundaryItems.push(boundary);
            boundaryCompilerIndex += 1;
          }
        } while (hasPendingWork() && performance.now() < sliceDeadline);
        if (hasPendingWork()) {
          await yieldToBrowser();
        }
      }
      if (cancelled || compileGenerationRef.current !== generation) {
        return;
      }
      startTransition(() => {
        setCompiledScene({
          generation,
          layer,
          source: features,
          renderedFeatures: renderedFeatureItems,
          renderedBoundaries: renderedBoundaryItems,
        });
      });
    };
    void compile();
    return () => {
      cancelled = true;
    };
  }, [compileFeatures, features, layer, renderer]);

  return {
    renderedFeatures:
      compiledScene.layer === layer ? compiledScene.renderedFeatures : EMPTY_RENDERED_FEATURES,
    renderedBoundaries:
      compiledScene.layer === layer ? compiledScene.renderedBoundaries : EMPTY_RENDERED_BOUNDARIES,
    generation: compiledScene.layer === layer ? compiledScene.generation : 0,
    ready: compiledScene.layer === layer && compiledScene.source === features,
    projection,
  };
}
