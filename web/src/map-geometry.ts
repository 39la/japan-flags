import { geoPath, type GeoContext, type GeoPath, type GeoProjection } from "d3-geo";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildMapProjection, buildMapRenderer } from "./map-model";
import type { MapFeature, MapArcGeometry, MapArcSource, MapLayer } from "./types";

export type RenderedFeature = {
  feature: MapFeature;
  canvasPath: Path2D | null;
  bounds: [[number, number], [number, number]];
};

export type RenderedBoundary = {
  source: BoundaryArcSet;
  canvasPaths: Path2D[];
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

export type MapSceneCompileMetrics = {
  sceneCommitCount: number;
  featureCompilationCount: number;
  boundaryCompilationCount: number;
  boundaryCacheHitCount: number;
  maxSliceMs: number;
  yieldCount: number;
  boundaryPointCount: number;
};

const GEOMETRY_COMPILE_SLICE_MS = 8;
const EMPTY_RENDERED_FEATURES: RenderedFeature[] = [];
const EMPTY_RENDERED_BOUNDARIES: RenderedBoundary[] = [];
const MAX_BOUNDARY_PATH_POINTS = 4096;
const MAX_BOUNDARY_CACHE_ENTRIES_PER_SOURCE = 4;
let boundaryCacheClock = 0;

function yieldToBrowser() {
  const scheduler = (
    window as Window & {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

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

function forEachArcPoint(
  store: ProjectedArcStore,
  arcIndex: number,
  callback: (point: ProjectedPoint, pointIndex: number) => void,
) {
  const points = store.get(arcIndex);
  if (arcIndex >= 0) {
    for (let index = 0; index < points.length; index += 1) {
      callback(points[index], index);
    }
    return;
  }
  for (let index = points.length - 1; index >= 0; index -= 1) {
    callback(points[index], points.length - 1 - index);
  }
}

function appendRing(path: Path2D, ring: number[], store: ProjectedArcStore) {
  let started = false;
  for (const arcIndex of ring) {
    forEachArcPoint(store, arcIndex, ([x, y], pointIndex) => {
      if (started && pointIndex === 0) return;
      if (!started) {
        path.moveTo(x, y);
        started = true;
      } else {
        path.lineTo(x, y);
      }
    });
  }
  if (started) path.closePath();
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
  const canvasPaths: Path2D[] = [];
  let activeCanvasPath: Path2D | null = null;
  let activeCanvasPointCount = 0;
  let arcIndex = 0;
  let pointCount = 0;
  let completed: RenderedBoundary | null = null;
  const bounds: [[number, number], [number, number]] = [
    [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  ];
  const finish = () => {
    const hasBounds = Number.isFinite(bounds[0][0]);
    const item: RenderedBoundary = {
      source,
      canvasPaths,
      bounds: hasBounds
        ? bounds
        : [
            [0, 0],
            [0, 0],
          ],
      pointCount,
    };
    completed = item;
    return item;
  };
  return {
    compiled: true,
    next: () => {
      if (completed) return completed;
      if (!source.arcIndexes.length) return finish();
      const points = store.get(source.arcIndexes[arcIndex]);
      pointCount += points.length;
      if (typeof Path2D !== "undefined" && points.length >= 2) {
        let startIndex = 0;
        while (startIndex < points.length - 1) {
          if (!activeCanvasPath || activeCanvasPointCount >= MAX_BOUNDARY_PATH_POINTS) {
            activeCanvasPath = new Path2D();
            canvasPaths.push(activeCanvasPath);
            activeCanvasPointCount = 0;
          }
          const available = Math.max(2, MAX_BOUNDARY_PATH_POINTS - activeCanvasPointCount);
          const endIndex = Math.min(points.length, startIndex + available);
          activeCanvasPath.moveTo(points[startIndex][0], points[startIndex][1]);
          for (let index = startIndex + 1; index < endIndex; index += 1) {
            activeCanvasPath.lineTo(points[index][0], points[index][1]);
          }
          activeCanvasPointCount += endIndex - startIndex;
          startIndex = endIndex - 1;
        }
      }
      for (const [x, y] of points) {
        bounds[0][0] = Math.min(bounds[0][0], x);
        bounds[0][1] = Math.min(bounds[0][1], y);
        bounds[1][0] = Math.max(bounds[1][0], x);
        bounds[1][1] = Math.max(bounds[1][1], y);
      }
      arcIndex += 1;
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
  let completed: RenderedFeature | null = null;
  const finish = () => {
    const item: RenderedFeature = {
      feature,
      canvasPath,
      bounds: projectedFeatureBounds(feature, projection, path),
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
        appendRing(canvasPath, topologyRings[geometryIndex], projectedStore);
        geometryIndex += 1;
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
) {
  const projectionRef = useRef<NonNullable<ReturnType<typeof buildMapProjection>> | null>(null);
  const featureCacheRef = useRef<RenderedFeatureCache>(new WeakMap());
  const boundaryCacheRef = useRef<RenderedBoundaryCache>(new WeakMap());
  const compileGenerationRef = useRef(0);
  const metricsRef = useRef<MapSceneCompileMetrics>({
    sceneCommitCount: 0,
    featureCompilationCount: 0,
    boundaryCompilationCount: 0,
    boundaryCacheHitCount: 0,
    maxSliceMs: 0,
    yieldCount: 0,
    boundaryPointCount: 0,
  });
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
      metricsRef.current.sceneCommitCount += 1;
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
    const featureCompilers = renderer.features.map((feature) => ({
      compiler: createRenderedFeatureCompiler(feature, renderer.path, renderer.projection, cache),
    }));
    const boundaryGroups = collectBoundarySourceGroups(features);
    const boundaryTasks = boundaryGroups.map((group) => {
      const cached = cachedRenderedBoundaries(boundaryCacheRef.current, group, renderer.projection);
      if (cached) {
        metricsRef.current.boundaryCacheHitCount += 1;
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
            metricsRef.current.featureCompilationCount += Number(current.compiler.compiled);
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
            metricsRef.current.boundaryCompilationCount += Number(compiler.compiled);
            metricsRef.current.boundaryPointCount += boundary.pointCount;
            boundaryCompilerIndex += 1;
          }
        } while (hasPendingWork() && performance.now() < sliceDeadline);
        metricsRef.current.maxSliceMs = Math.max(
          metricsRef.current.maxSliceMs,
          performance.now() - sliceStart,
        );
        if (hasPendingWork()) {
          metricsRef.current.yieldCount += 1;
          await yieldToBrowser();
        }
      }
      if (cancelled || compileGenerationRef.current !== generation) {
        return;
      }
      metricsRef.current.sceneCommitCount += 1;
      setCompiledScene({
        generation,
        layer,
        source: features,
        renderedFeatures: renderedFeatureItems,
        renderedBoundaries: renderedBoundaryItems,
      });
    };
    void compile();
    return () => {
      cancelled = true;
    };
  }, [features, layer, renderer]);

  return {
    renderedFeatures:
      compiledScene.layer === layer ? compiledScene.renderedFeatures : EMPTY_RENDERED_FEATURES,
    renderedBoundaries:
      compiledScene.layer === layer ? compiledScene.renderedBoundaries : EMPTY_RENDERED_BOUNDARIES,
    generation: compiledScene.layer === layer ? compiledScene.generation : 0,
    ready: compiledScene.layer === layer && compiledScene.source === features,
    metricsRef,
    projection,
  };
}
