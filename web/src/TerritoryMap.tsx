import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import { fitCanvasViewport, viewportPointToContent } from "./canvas-viewport";
import { getFlagFitStrategy, placeMotif } from "./flag-fit";
import {
  cachedFlagRaster,
  cachedFlagSvg,
  cachedPrefectureSpriteAtlas,
  loadSpriteAtlas,
  prefetchFlagResources,
  preloadPrefectureSpriteAtlas,
  requestFlagResources,
  requestPrefectureSpriteAtlases,
  type SpriteAtlas,
} from "./flag-resources";
import {
  loadFlagVisualManifest,
  type FlagVisualManifest,
  type MotifRenderSettings,
} from "./flag-visuals";
import { ResetIcon } from "./icons";
import { exportCamera, type MapExportRequest } from "./map-export";
import { useCompiledMapScene, type RenderedBoundary, type RenderedFeature } from "./map-geometry";
import { MAP_HEIGHT, MAP_WIDTH, focusBounds } from "./map-model";
import {
  buildFlagResourceIntent,
  buildRenderPlan,
  featureKey,
  isVisible,
  prefectureCode,
} from "./render-plan";
import { geometryLodForRenderScale, physicalRenderScale, type GeometryLod } from "./render-scale";
import { buildMapSvg } from "./svg-renderer";
import type { FlagFitMode, MapDisplayOptions, MapFeature, MapLayer, ViewTransform } from "./types";

declare global {
  interface Window {
    __renderMapExportSvg?: (dimensions: { width: number; height: number }) => Promise<string>;
  }
}

type Props = {
  features: MapFeature[];
  municipalityBoundaryFeatures: MapFeature[];
  prefectureBoundaryFeatures: MapFeature[];
  layer: MapLayer;
  selected: MapFeature | null;
  focusRequest: number;
  focusedPrefecture: string | null;
  fitMode: FlagFitMode;
  motifSettings: MotifRenderSettings;
  displayOptions: MapDisplayOptions;
  exportRequest: MapExportRequest | null;
  exportDataReady: boolean;
  geometryLod: GeometryLod;
  onSelect: (feature: MapFeature) => void;
  onVisiblePrefecturesChange?: (codes: string[]) => void;
  onGeometryLodChange?: (lod: GeometryLod) => void;
};

type DragState = {
  x: number;
  y: number;
  moved: boolean;
  origin: ViewTransform;
};

type SceneCache = {
  canvas: HTMLCanvasElement;
  camera: ViewTransform;
  marginX: number;
  marginY: number;
  logicalWidth: number;
  logicalHeight: number;
  visiblePixelWidth: number;
  visiblePixelHeight: number;
  sceneGeneration: number;
  resourceRevision: number;
  layer: MapLayer;
  fitMode: FlagFitMode;
  focusedPrefecture: string | null;
  motifSettingsSignature: string;
};

const NATIONAL_ZOOM = 1.08;
const nationalView: ViewTransform = {
  x: MAP_WIDTH / 2 - (NATIONAL_ZOOM * MAP_WIDTH) / 2,
  y: MAP_HEIGHT / 2 - (NATIONAL_ZOOM * MAP_HEIGHT) / 2,
  k: NATIONAL_ZOOM,
};
const SCENE_OVERSCAN = 1.6;
const CAMERA_SETTLE_MS = 120;
const MAX_SCENE_PIXEL_RATIO = 1.5;
const MAX_CAMERA_ZOOM = 24;
const DETAIL_PREFETCH_MARGIN = 160;
const EMPTY_BOUNDARY_FEATURES: MapFeature[] = [];

export function sceneCacheContainsViewport(
  cache: Pick<
    SceneCache,
    "camera" | "marginX" | "marginY" | "visiblePixelWidth" | "visiblePixelHeight"
  >,
  camera: ViewTransform,
  visiblePixelWidth: number,
  visiblePixelHeight: number,
) {
  if (
    camera.k !== cache.camera.k ||
    visiblePixelWidth !== cache.visiblePixelWidth ||
    visiblePixelHeight !== cache.visiblePixelHeight
  ) {
    return false;
  }
  const oldScreenOffsetX = cache.camera.x - camera.x;
  const oldScreenOffsetY = cache.camera.y - camera.y;
  return (
    oldScreenOffsetX >= -cache.marginX &&
    oldScreenOffsetX <= cache.marginX &&
    oldScreenOffsetY >= -cache.marginY &&
    oldScreenOffsetY <= cache.marginY
  );
}

function featureIsSelected(feature: MapFeature, selected: MapFeature | null) {
  if (!selected) return false;
  if (
    feature.properties.entityType === "prefecture" &&
    selected.properties.entityType === "prefecture"
  ) {
    return feature.properties.prefectureCode === selected.properties.prefectureCode;
  }
  return featureKey(feature) === featureKey(selected);
}

function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  return viewportPointToContent(
    fitCanvasViewport(rect.width, rect.height, MAP_WIDTH, MAP_HEIGHT),
    clientX - rect.left,
    clientY - rect.top,
  );
}

function strokeBoundaryLayer(
  context: CanvasRenderingContext2D,
  boundaries: RenderedBoundary[],
  camera: ViewTransform,
  strokeStyle: string,
  lineWidth: number,
) {
  context.strokeStyle = strokeStyle;
  context.lineWidth = lineWidth / camera.k;
  context.lineJoin = "round";
  context.lineCap = "round";
  for (const boundary of boundaries) {
    if (!boundary.canvasPaths.length || !isVisible(boundary.bounds, camera)) continue;
    for (const path of boundary.canvasPaths) context.stroke(path);
  }
}

export function focusFeatureCamera(
  renderedFeatures: RenderedFeature[],
  selected: MapFeature,
  layer: MapLayer,
) {
  const matches = renderedFeatures.filter((item) => featureIsSelected(item.feature, selected));
  if (!matches.length) return null;
  const bounds = matches.reduce<[[number, number], [number, number]]>(
    (current, item) => [
      [Math.min(current[0][0], item.bounds[0][0]), Math.min(current[0][1], item.bounds[0][1])],
      [Math.max(current[1][0], item.bounds[1][0]), Math.max(current[1][1], item.bounds[1][1])],
    ],
    [
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    ],
  );
  return focusBounds(bounds, layer === "prefecture" ? 8 : 14, layer === "prefecture" ? 0.55 : 0.42);
}

export function TerritoryMap({
  features,
  municipalityBoundaryFeatures,
  prefectureBoundaryFeatures,
  layer,
  selected,
  focusRequest,
  focusedPrefecture,
  fitMode,
  motifSettings,
  displayOptions,
  exportRequest,
  exportDataReady,
  geometryLod,
  onSelect,
  onVisiblePrefecturesChange,
  onGeometryLodChange,
}: Props) {
  const resourceBatchGenerationRef = useRef(0);
  const [hovered, setHovered] = useState<MapFeature | null>(null);
  const {
    renderedFeatures,
    renderedBoundaries,
    generation: sceneGeneration,
    metricsRef: sceneMetricsRef,
    projection,
    ready: compiledSceneReady,
  } = useCompiledMapScene(features, layer);
  const prefectureOverlayFeatures = useMemo(
    () =>
      layer === "municipality" && displayOptions.showPrefectureBoundaries
        ? prefectureBoundaryFeatures
        : EMPTY_BOUNDARY_FEATURES,
    [displayOptions.showPrefectureBoundaries, layer, prefectureBoundaryFeatures],
  );
  const municipalityHoverFeatures = useMemo(() => {
    if (
      layer !== "prefecture" ||
      !displayOptions.showMunicipalityBoundariesOnPrefectureHover ||
      !hovered
    ) {
      return EMPTY_BOUNDARY_FEATURES;
    }
    const hoveredPrefectureCode = prefectureCode(hovered);
    return municipalityBoundaryFeatures.filter(
      (feature) => prefectureCode(feature) === hoveredPrefectureCode,
    );
  }, [
    displayOptions.showMunicipalityBoundariesOnPrefectureHover,
    hovered,
    layer,
    municipalityBoundaryFeatures,
  ]);
  const { renderedBoundaries: prefectureOverlayBoundaries, ready: prefectureOverlayReady } =
    useCompiledMapScene(prefectureOverlayFeatures, "prefecture", projection);
  const { renderedBoundaries: municipalityHoverBoundaries } = useCompiledMapScene(
    municipalityHoverFeatures,
    "municipality",
    projection,
  );
  const [spriteAtlas, setSpriteAtlas] = useState<SpriteAtlas | null>(null);
  const [spriteAtlasFailed, setSpriteAtlasFailed] = useState(false);
  const [spriteAtlasSettled, setSpriteAtlasSettled] = useState(false);
  const [flagVisualManifest, setFlagVisualManifest] = useState<FlagVisualManifest | null>(null);
  const [flagVisualManifestSettled, setFlagVisualManifestSettled] = useState(false);
  const [exportReady, setExportReady] = useState(false);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const sceneCacheRef = useRef<SceneCache | null>(null);
  const hitContextRef = useRef<CanvasRenderingContext2D | null>(null);
  const drag = useRef<DragState | null>(null);
  const cameraRef = useRef<ViewTransform>({ ...nationalView });
  const initializedRef = useRef(false);
  const handledFocusRequestRef = useRef(0);
  const cameraFrameRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const isInteractingRef = useRef(false);
  const renderSettledRef = useRef<() => void>(() => undefined);
  const drawCachedBaseRef = useRef<() => void>(() => undefined);
  const drawOverlayRef = useRef<() => void>(() => undefined);
  const scheduleSettledRef = useRef<(delay?: number) => void>(() => undefined);
  const visiblePrefectureSignature = useRef("");
  const geometryLodRef = useRef<GeometryLod>("l0");
  const resourceRevisionRef = useRef(0);
  const resourceBatchPendingRef = useRef(false);
  const resourceIntentSignatureRef = useRef("");
  const resourceIntentAtRef = useRef(0);
  const motifSettingsSignature = JSON.stringify(motifSettings);

  useEffect(() => {
    const hitCanvas = document.createElement("canvas");
    hitContextRef.current = hitCanvas.getContext("2d");
    sceneCacheRef.current = {
      canvas: document.createElement("canvas"),
      camera: { ...nationalView },
      marginX: 0,
      marginY: 0,
      logicalWidth: MAP_WIDTH,
      logicalHeight: MAP_HEIGHT,
      visiblePixelWidth: 0,
      visiblePixelHeight: 0,
      sceneGeneration: 0,
      resourceRevision: -1,
      layer,
      fitMode,
      focusedPrefecture,
      motifSettingsSignature,
    };
    return () => {
      if (cameraFrameRef.current !== null) {
        window.cancelAnimationFrame(cameraFrameRef.current);
      }
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      resourceBatchGenerationRef.current += 1;
      sceneCacheRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (spriteAtlas || spriteAtlasFailed) return;
    let active = true;
    loadSpriteAtlas()
      .then((atlas) => {
        if (active) {
          resourceRevisionRef.current += 1;
          setSpriteAtlas(atlas);
          setSpriteAtlasSettled(true);
        }
      })
      .catch(() => {
        if (active) {
          resourceRevisionRef.current += 1;
          setSpriteAtlasFailed(true);
          setSpriteAtlasSettled(true);
        }
      });
    return () => {
      active = false;
    };
  }, [spriteAtlas, spriteAtlasFailed]);

  useEffect(() => {
    if (flagVisualManifest) return;
    let active = true;
    loadFlagVisualManifest()
      .then((manifest) => {
        if (!active) return;
        resourceRevisionRef.current += 1;
        setFlagVisualManifest(manifest);
        setFlagVisualManifestSettled(true);
      })
      .catch(() => {
        // The existing full-flag modes remain usable without this manifest.
        if (active) setFlagVisualManifestSettled(true);
      });
    return () => {
      active = false;
    };
  }, [flagVisualManifest]);

  useEffect(() => {
    if (!renderedFeatures.length) {
      return;
    }
    if (exportRequest) {
      const camera = exportCamera(renderedFeatures, exportRequest, nationalView);
      if (!camera) return;
      initializedRef.current = true;
      cameraRef.current = camera;
      setExportReady(false);
      drawCachedBaseRef.current();
      drawOverlayRef.current();
      scheduleSettledRef.current(0);
      return;
    }
    if (initializedRef.current) return;
    initializedRef.current = true;
    cameraRef.current = { ...nationalView };
    drawCachedBaseRef.current();
    drawOverlayRef.current();
    scheduleSettledRef.current(0);
  }, [exportRequest, renderedFeatures, layer]);

  useEffect(() => {
    if (exportRequest) setExportReady(false);
  }, [exportDataReady, exportRequest, sceneGeneration]);

  useEffect(() => {
    if (!exportRequest || !projection) return;
    window.__renderMapExportSvg = ({ width, height }) =>
      buildMapSvg({
        width,
        height,
        layer,
        fitMode,
        camera: cameraRef.current,
        projection,
        renderedFeatures,
        renderedBoundaries,
        prefectureOverlayBoundaries,
        showPrefectureBoundaries:
          layer === "municipality" && displayOptions.showPrefectureBoundaries,
        spriteEntries: spriteAtlas?.sprites,
        flagVisualManifest,
        motifSettings,
      });
    return () => {
      delete window.__renderMapExportSvg;
    };
  }, [
    displayOptions.showPrefectureBoundaries,
    exportRequest,
    fitMode,
    flagVisualManifest,
    layer,
    motifSettings,
    prefectureOverlayBoundaries,
    projection,
    renderedBoundaries,
    renderedFeatures,
    spriteAtlas,
  ]);

  const updateVisiblePrefectures = useCallback(
    (camera: ViewTransform) => {
      if (!onVisiblePrefecturesChange) return;
      const codes =
        camera.k >= 3
          ? [
              ...new Set(
                renderedFeatures
                  .filter((item) =>
                    isVisible(item.bounds, camera, DETAIL_PREFETCH_MARGIN, DETAIL_PREFETCH_MARGIN),
                  )
                  .map((item) => prefectureCode(item.feature)),
              ),
            ].sort()
          : [];
      const signature = codes.join(",");
      if (signature === visiblePrefectureSignature.current) return;
      visiblePrefectureSignature.current = signature;
      onVisiblePrefecturesChange(codes);
    },
    [renderedFeatures, layer, onVisiblePrefecturesChange],
  );

  const renderVectorScene = useCallback(
    (camera: ViewTransform) => {
      const visibleCanvas = baseCanvasRef.current;
      const cache = sceneCacheRef.current;
      if (!visibleCanvas || !cache || typeof Path2D === "undefined") {
        return false;
      }
      const width = Math.max(1, visibleCanvas.clientWidth);
      const height = Math.max(1, visibleCanvas.clientHeight);
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_SCENE_PIXEL_RATIO);
      const viewport = fitCanvasViewport(width * ratio, height * ratio, MAP_WIDTH, MAP_HEIGHT);
      const marginX = ((SCENE_OVERSCAN - 1) * MAP_WIDTH) / 2;
      const marginY = ((SCENE_OVERSCAN - 1) * MAP_HEIGHT) / 2;
      const logicalWidth = MAP_WIDTH + marginX * 2;
      const logicalHeight = MAP_HEIGHT + marginY * 2;
      const targetWidth = Math.max(1, Math.round(logicalWidth * viewport.scale));
      const targetHeight = Math.max(1, Math.round(logicalHeight * viewport.scale));
      if (cache.canvas.width !== targetWidth || cache.canvas.height !== targetHeight) {
        cache.canvas.width = targetWidth;
        cache.canvas.height = targetHeight;
      }
      const context = cache.canvas.getContext("2d");
      if (!context) return false;
      if (import.meta.env.DEV) {
        visibleCanvas.dataset.vectorRenders = String(
          Number(visibleCanvas.dataset.vectorRenders ?? 0) + 1,
        );
        visibleCanvas.dataset.camera = JSON.stringify(camera);
        visibleCanvas.dataset.geometryCompiles = String(
          sceneMetricsRef.current.featureCompilationCount,
        );
        visibleCanvas.dataset.geometryCompileMaxSliceMs =
          sceneMetricsRef.current.maxSliceMs.toFixed(1);
        visibleCanvas.dataset.geometryCompileYields = String(sceneMetricsRef.current.yieldCount);
        visibleCanvas.dataset.boundaryCompiles = String(
          sceneMetricsRef.current.boundaryCompilationCount,
        );
        visibleCanvas.dataset.boundaryCompileMaxSliceMs =
          sceneMetricsRef.current.maxSliceMs.toFixed(1);
        visibleCanvas.dataset.boundaryCompileYields = String(sceneMetricsRef.current.yieldCount);
        visibleCanvas.dataset.boundaryPoints = String(sceneMetricsRef.current.boundaryPointCount);
        visibleCanvas.dataset.sceneCommits = String(sceneMetricsRef.current.sceneCommitCount);
        visibleCanvas.dataset.boundaryCacheHits = String(
          sceneMetricsRef.current.boundaryCacheHitCount,
        );
        visibleCanvas.dataset.resourceIntentLeadMs =
          resourceIntentAtRef.current > 0
            ? Math.max(0, performance.now() - resourceIntentAtRef.current).toFixed(1)
            : "0.0";
        visibleCanvas.dataset.boundaryCurrentPoints = String(
          renderedBoundaries.reduce((total, boundary) => total + boundary.pointCount, 0),
        );
        visibleCanvas.dataset.boundaryPathBatches = String(
          renderedBoundaries.reduce((total, boundary) => total + boundary.canvasPaths.length, 0),
        );
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, targetWidth, targetHeight);
      context.setTransform(
        viewport.scale,
        0,
        0,
        viewport.scale,
        marginX * viewport.scale,
        marginY * viewport.scale,
      );
      context.translate(camera.x, camera.y);
      context.scale(camera.k, camera.k);

      const renderScale = physicalRenderScale(viewport.scale, camera.k);
      const geometryLod = geometryLodForRenderScale(renderScale, geometryLodRef.current);
      if (geometryLod !== geometryLodRef.current) {
        geometryLodRef.current = geometryLod;
        onGeometryLodChange?.(geometryLod);
      }
      const plan = buildRenderPlan({
        items: renderedFeatures,
        camera,
        renderScale,
        fitMode,
        spriteEntries: spriteAtlas?.sprites,
        focusedPrefecture,
        spriteAtlasFailed,
        marginX,
        marginY,
        flagVisualManifest,
        motifSettings,
      });
      const resourceGeneration = resourceBatchGenerationRef.current + 1;
      resourceBatchGenerationRef.current = resourceGeneration;
      const resourceBatch = requestFlagResources(plan.rasterRequests, plan.svgRequests);
      const atlasBatch = requestPrefectureSpriteAtlases(plan.prefectureAtlasRequests);
      const pendingResources = [resourceBatch, atlasBatch].filter(
        (batch): batch is Promise<boolean> => batch !== null,
      );
      resourceBatchPendingRef.current = pendingResources.length > 0;
      if (pendingResources.length) {
        if (exportRequest) setExportReady(false);
        void Promise.all(pendingResources).then(() => {
          if (resourceBatchGenerationRef.current === resourceGeneration) {
            resourceBatchPendingRef.current = false;
            resourceRevisionRef.current += 1;
            scheduleSettledRef.current(0);
          }
        });
      }

      const strategy = getFlagFitStrategy(fitMode === "motif" ? "cover" : fitMode);
      for (const planned of plan.features) {
        const {
          item,
          hasFlag,
          resourcePath,
          visual,
          motifPlacement,
          rasterBucket: bucket,
          useDirectSvg,
        } = planned;
        const path = item.canvasPath;
        const properties = item.feature.properties;
        const separated =
          fitMode === "motif" && visual?.kind === "separated" && motifPlacement !== null;
        const showFlag = hasFlag && resourcePath && bucket;
        context.fillStyle =
          separated && visual.background.kind === "solid"
            ? visual.background.color
            : hasFlag
              ? "#ffffff"
              : "#edf0f2";
        context.fill(path);

        if (separated && visual.background.kind === "asset") {
          const background = cachedFlagSvg(visual.background.path);
          if (background) {
            const placement = getFlagFitStrategy("cover").place(
              background.width,
              background.height,
              item.bounds,
            );
            context.save();
            context.clip(path);
            context.drawImage(
              background.image,
              placement.x,
              placement.y,
              placement.width,
              placement.height,
            );
            context.restore();
          }
        }

        if (showFlag && resourcePath && bucket) {
          const svg = useDirectSvg ? cachedFlagSvg(resourcePath) : null;
          const raster = cachedFlagRaster(resourcePath, bucket);
          if (svg) {
            const placement =
              separated && motifPlacement
                ? placeMotif(
                    svg.width,
                    svg.height,
                    item.bounds,
                    properties.visualAnchor,
                    properties.visualSafeRadiusRatio,
                    motifPlacement,
                    properties.visualCentroidAnchor,
                    properties.visualOptimizedAnchor,
                    properties.visualComponentBounds,
                  )
                : strategy.place(svg.width, svg.height, item.bounds);
            context.save();
            context.clip(path);
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = "high";
            context.drawImage(
              svg.image,
              placement.x,
              placement.y,
              placement.width,
              placement.height,
            );
            context.restore();
          } else if (raster) {
            const placement =
              separated && motifPlacement
                ? placeMotif(
                    raster.width,
                    raster.height,
                    item.bounds,
                    properties.visualAnchor,
                    properties.visualSafeRadiusRatio,
                    motifPlacement,
                    properties.visualCentroidAnchor,
                    properties.visualOptimizedAnchor,
                    properties.visualComponentBounds,
                  )
                : strategy.place(raster.width, raster.height, item.bounds);
            context.save();
            context.clip(path);
            context.drawImage(
              raster.bitmap,
              placement.x,
              placement.y,
              placement.width,
              placement.height,
            );
            context.restore();
          } else {
            const prefectureAtlas =
              bucket === 64 ? cachedPrefectureSpriteAtlas(prefectureCode(item.feature)) : null;
            const atlas = prefectureAtlas?.sprites[resourcePath] ? prefectureAtlas : spriteAtlas;
            const sprite = atlas?.sprites[resourcePath];
            if (sprite && atlas) {
              const placement =
                separated && motifPlacement
                  ? placeMotif(
                      sprite.width,
                      sprite.height,
                      item.bounds,
                      properties.visualAnchor,
                      properties.visualSafeRadiusRatio,
                      motifPlacement,
                      properties.visualCentroidAnchor,
                      properties.visualOptimizedAnchor,
                      properties.visualComponentBounds,
                    )
                  : strategy.place(sprite.width, sprite.height, item.bounds);
              context.save();
              context.clip(path);
              context.imageSmoothingEnabled = true;
              context.imageSmoothingQuality = "high";
              context.drawImage(
                atlas.image,
                sprite.x,
                sprite.y,
                sprite.width,
                sprite.height,
                placement.x,
                placement.y,
                placement.width,
                placement.height,
              );
              context.restore();
            }
          }
        }
      }

      context.strokeStyle = "#aeb6bc";
      context.lineWidth = 0.62 / camera.k;
      for (const boundary of renderedBoundaries) {
        if (boundary.canvasPaths.length && isVisible(boundary.bounds, camera, marginX, marginY)) {
          for (const path of boundary.canvasPaths) {
            context.stroke(path);
          }
        }
      }

      cache.camera = { ...camera };
      cache.marginX = marginX;
      cache.marginY = marginY;
      cache.logicalWidth = logicalWidth;
      cache.logicalHeight = logicalHeight;
      cache.visiblePixelWidth = Math.round(width * ratio);
      cache.visiblePixelHeight = Math.round(height * ratio);
      cache.sceneGeneration = sceneGeneration;
      cache.resourceRevision = resourceRevisionRef.current;
      cache.layer = layer;
      cache.fitMode = fitMode;
      cache.focusedPrefecture = focusedPrefecture;
      cache.motifSettingsSignature = motifSettingsSignature;
      return true;
    },
    [
      fitMode,
      focusedPrefecture,
      flagVisualManifest,
      layer,
      motifSettings,
      motifSettingsSignature,
      renderedBoundaries,
      renderedFeatures,
      sceneGeneration,
      spriteAtlas,
      spriteAtlasFailed,
      onGeometryLodChange,
      exportRequest,
    ],
  );

  const ensureVisibleCanvasSizes = useCallback(() => {
    const base = baseCanvasRef.current;
    const overlay = overlayCanvasRef.current;
    if (!base || !overlay) return false;
    const width = Math.max(1, base.clientWidth);
    const height = Math.max(1, base.clientHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const targetWidth = Math.round(width * ratio);
    const targetHeight = Math.round(height * ratio);
    let resized = false;
    for (const canvas of [base, overlay]) {
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        resized = true;
      }
    }
    return resized;
  }, []);

  const drawCachedBase = useCallback(() => {
    const canvas = baseCanvasRef.current;
    const cache = sceneCacheRef.current;
    if (!canvas || !cache || !cache.canvas.width) return;
    ensureVisibleCanvasSizes();
    const context = canvas.getContext("2d");
    if (!context) return;
    if (import.meta.env.DEV) {
      canvas.dataset.cachedFrames = String(Number(canvas.dataset.cachedFrames ?? 0) + 1);
    }
    const camera = cameraRef.current;
    const cameraScale = camera.k / cache.camera.k;
    const translateX = camera.x - cameraScale * cache.camera.x;
    const translateY = camera.y - cameraScale * cache.camera.y;
    const viewport = fitCanvasViewport(canvas.width, canvas.height, MAP_WIDTH, MAP_HEIGHT);

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(viewport.scale, 0, 0, viewport.scale, viewport.offsetX, viewport.offsetY);
    context.translate(translateX, translateY);
    context.scale(cameraScale, cameraScale);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      cache.canvas,
      -cache.marginX,
      -cache.marginY,
      cache.logicalWidth,
      cache.logicalHeight,
    );
  }, [ensureVisibleCanvasSizes]);
  drawCachedBaseRef.current = drawCachedBase;

  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || typeof Path2D === "undefined") return;
    ensureVisibleCanvasSizes();
    const context = canvas.getContext("2d");
    if (!context) return;
    const camera = cameraRef.current;
    const viewport = fitCanvasViewport(canvas.width, canvas.height, MAP_WIDTH, MAP_HEIGHT);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(viewport.scale, 0, 0, viewport.scale, viewport.offsetX, viewport.offsetY);
    context.translate(camera.x, camera.y);
    context.scale(camera.k, camera.k);

    if (layer === "municipality" && displayOptions.showPrefectureBoundaries) {
      strokeBoundaryLayer(context, prefectureOverlayBoundaries, camera, "#6f7980", 1.18);
    }
    if (
      layer === "prefecture" &&
      displayOptions.showMunicipalityBoundariesOnPrefectureHover &&
      hovered
    ) {
      strokeBoundaryLayer(context, municipalityHoverBoundaries, camera, "#68737a", 0.72);
    }

    for (const item of renderedFeatures) {
      const selectedFeature = featureIsSelected(item.feature, selected);
      const hoveredFeature = hovered && featureKey(item.feature) === featureKey(hovered);
      if (
        (!selectedFeature && !hoveredFeature) ||
        !item.canvasPath ||
        !isVisible(item.bounds, camera)
      ) {
        continue;
      }
      context.strokeStyle = selectedFeature ? "#d3261d" : "#202326";
      context.lineWidth = (selectedFeature ? 3 : 1.4) / camera.k;
      context.stroke(item.canvasPath);
    }
  }, [
    displayOptions.showMunicipalityBoundariesOnPrefectureHover,
    displayOptions.showPrefectureBoundaries,
    ensureVisibleCanvasSizes,
    hovered,
    layer,
    municipalityHoverBoundaries,
    prefectureOverlayBoundaries,
    renderedFeatures,
    selected,
  ]);
  drawOverlayRef.current = drawOverlay;

  const updateExportReady = useCallback(() => {
    if (!exportRequest) return;
    const overlayReady =
      layer !== "municipality" ||
      !displayOptions.showPrefectureBoundaries ||
      prefectureOverlayReady;
    setExportReady(
      exportDataReady &&
        compiledSceneReady &&
        overlayReady &&
        spriteAtlasSettled &&
        flagVisualManifestSettled &&
        geometryLodRef.current === geometryLod &&
        !resourceBatchPendingRef.current,
    );
  }, [
    compiledSceneReady,
    displayOptions.showPrefectureBoundaries,
    exportDataReady,
    exportRequest,
    flagVisualManifestSettled,
    geometryLod,
    layer,
    prefectureOverlayReady,
    spriteAtlasSettled,
  ]);

  const canReuseCachedScene = useCallback(
    (camera: ViewTransform) => {
      const canvas = baseCanvasRef.current;
      const cache = sceneCacheRef.current;
      if (!canvas || !cache || !cache.canvas.width) return false;
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_SCENE_PIXEL_RATIO);
      const visiblePixelWidth = Math.round(Math.max(1, canvas.clientWidth) * ratio);
      const visiblePixelHeight = Math.round(Math.max(1, canvas.clientHeight) * ratio);
      return (
        cache.sceneGeneration === sceneGeneration &&
        cache.resourceRevision === resourceRevisionRef.current &&
        cache.layer === layer &&
        cache.fitMode === fitMode &&
        cache.focusedPrefecture === focusedPrefecture &&
        cache.motifSettingsSignature === motifSettingsSignature &&
        sceneCacheContainsViewport(cache, camera, visiblePixelWidth, visiblePixelHeight)
      );
    },
    [fitMode, focusedPrefecture, layer, motifSettingsSignature, sceneGeneration],
  );

  const renderSettled = useCallback(() => {
    const camera = cameraRef.current;
    if (canReuseCachedScene(camera)) {
      const canvas = baseCanvasRef.current;
      if (canvas && import.meta.env.DEV) {
        canvas.dataset.overscanHits = String(Number(canvas.dataset.overscanHits ?? 0) + 1);
      }
      drawCachedBase();
      drawOverlayRef.current();
      updateVisiblePrefectures(camera);
      updateExportReady();
      return;
    }
    if (!renderVectorScene(camera)) return;
    drawCachedBase();
    drawOverlayRef.current();
    updateVisiblePrefectures(camera);
    updateExportReady();
  }, [
    canReuseCachedScene,
    drawCachedBase,
    renderVectorScene,
    updateExportReady,
    updateVisiblePrefectures,
  ]);
  renderSettledRef.current = renderSettled;

  const scheduleSettled = useCallback((delay = CAMERA_SETTLE_MS) => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
    }
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      if (isInteractingRef.current) {
        scheduleSettledRef.current();
        return;
      }
      renderSettledRef.current();
    }, delay);
  }, []);
  scheduleSettledRef.current = scheduleSettled;

  const prefetchCameraResources = useCallback(
    (camera: ViewTransform) => {
      const canvas = baseCanvasRef.current;
      if (!canvas || !renderedFeatures.length) return;
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_SCENE_PIXEL_RATIO);
      const viewport = fitCanvasViewport(
        Math.max(1, canvas.clientWidth) * ratio,
        Math.max(1, canvas.clientHeight) * ratio,
        MAP_WIDTH,
        MAP_HEIGHT,
      );
      const intent = buildFlagResourceIntent({
        items: renderedFeatures,
        camera,
        renderScale: physicalRenderScale(viewport.scale, camera.k),
        fitMode,
        spriteEntries: spriteAtlas?.sprites,
        focusedPrefecture,
        spriteAtlasFailed,
        flagVisualManifest,
        motifSettings,
      });
      if (intent.signature === resourceIntentSignatureRef.current) return;
      resourceIntentSignatureRef.current = intent.signature;
      resourceIntentAtRef.current = performance.now();
      void prefetchFlagResources(intent.rasterRequests, intent.svgRequests);
      for (const code of intent.prefectureAtlasRequests) {
        void preloadPrefectureSpriteAtlas(code);
      }
    },
    [
      fitMode,
      focusedPrefecture,
      flagVisualManifest,
      motifSettings,
      renderedFeatures,
      spriteAtlas,
      spriteAtlasFailed,
    ],
  );

  const queueCameraFrame = useCallback(() => {
    if (cameraFrameRef.current !== null) return;
    cameraFrameRef.current = window.requestAnimationFrame(() => {
      cameraFrameRef.current = null;
      drawCachedBaseRef.current();
      drawOverlayRef.current();
      prefetchCameraResources(cameraRef.current);
    });
  }, [prefetchCameraResources]);

  const setCamera = useCallback(
    (camera: ViewTransform, settleDelay = CAMERA_SETTLE_MS) => {
      cameraRef.current = camera;
      queueCameraFrame();
      scheduleSettled(settleDelay);
    },
    [queueCameraFrame, scheduleSettled],
  );

  useEffect(() => {
    if (
      !selected ||
      focusRequest === 0 ||
      handledFocusRequestRef.current === focusRequest ||
      !renderedFeatures.length
    ) {
      return;
    }
    const camera = focusFeatureCamera(renderedFeatures, selected, layer);
    if (!camera) return;
    handledFocusRequestRef.current = focusRequest;
    setCamera(camera, 0);
  }, [focusRequest, layer, renderedFeatures, selected, setCamera]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      renderSettledRef.current();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renderSettled]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(drawOverlay);
    return () => window.cancelAnimationFrame(frame);
  }, [drawOverlay]);

  useEffect(() => {
    const canvas = baseCanvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      renderSettledRef.current();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const zoom = (factor: number) => {
    const current = cameraRef.current;
    const k = Math.max(NATIONAL_ZOOM, Math.min(MAX_CAMERA_ZOOM, current.k * factor));
    setCamera({
      k,
      x: MAP_WIDTH / 2 - (k / current.k) * (MAP_WIDTH / 2 - current.x),
      y: MAP_HEIGHT / 2 - (k / current.k) * (MAP_HEIGHT / 2 - current.y),
    });
  };

  const hitTest = (clientX: number, clientY: number) => {
    const canvas = overlayCanvasRef.current;
    const context = hitContextRef.current;
    if (!canvas || !context || typeof Path2D === "undefined") return null;
    const point = canvasPoint(canvas, clientX, clientY);
    const camera = cameraRef.current;
    const worldX = (point.x - camera.x) / camera.k;
    const worldY = (point.y - camera.y) / camera.k;
    for (let index = renderedFeatures.length - 1; index >= 0; index -= 1) {
      const item = renderedFeatures[index];
      const [[x0, y0], [x1, y1]] = item.bounds;
      if (worldX < x0 || worldX > x1 || worldY < y0 || worldY > y1) {
        continue;
      }
      if (item.canvasPath && context.isPointInPath(item.canvasPath, worldX, worldY)) {
        return item.feature;
      }
    }
    return null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    isInteractingRef.current = true;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      moved: false,
      origin: { ...cameraRef.current },
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) {
      const feature = hitTest(event.clientX, event.clientY);
      const nextKey = feature ? featureKey(feature) : null;
      const hoveredKey = hovered ? featureKey(hovered) : null;
      if (nextKey !== hoveredKey) {
        setHovered(feature);
      }
      return;
    }
    const viewport = fitCanvasViewport(
      event.currentTarget.clientWidth,
      event.currentTarget.clientHeight,
      MAP_WIDTH,
      MAP_HEIGHT,
    );
    const scale = 1 / viewport.scale;
    const dx = event.clientX - drag.current.x;
    const dy = event.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
    setCamera(
      {
        ...drag.current.origin,
        x: drag.current.origin.x + dx * scale,
        y: drag.current.origin.y + dy * scale,
      },
      CAMERA_SETTLE_MS,
    );
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const wasDrag = drag.current?.moved;
    drag.current = null;
    isInteractingRef.current = false;
    if (!wasDrag) {
      const feature = hitTest(event.clientX, event.clientY);
      if (feature) onSelect(feature);
    } else {
      scheduleSettled(0);
    }
  };

  return (
    <div className="map-shell" data-export-ready={exportRequest ? String(exportReady) : undefined}>
      <canvas ref={baseCanvasRef} className="map-canvas map-base-canvas" aria-hidden="true" />
      <canvas
        ref={overlayCanvasRef}
        className="map map-canvas map-overlay-canvas"
        role="img"
        aria-label={layer === "prefecture" ? "全国都道府県旗マップ" : "全国市区町村旗マップ"}
        onWheel={(event: WheelEvent<HTMLCanvasElement>) => {
          event.preventDefault();
          zoom(event.deltaY < 0 ? 1.18 : 0.84);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (!drag.current) setHovered(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          isInteractingRef.current = false;
          scheduleSettled(0);
        }}
      />
      <div className="zoom-controls" aria-label="地図操作">
        <button type="button" aria-label="拡大" onClick={() => zoom(1.3)}>
          ＋
        </button>
        <button type="button" aria-label="縮小" onClick={() => zoom(0.76)}>
          −
        </button>
        <button
          type="button"
          aria-label="全国表示に戻す"
          onClick={() => setCamera({ ...nationalView }, 0)}
        >
          <ResetIcon />
        </button>
      </div>
      {hovered && (
        <div className="map-tooltip" aria-live="polite">
          {hovered.properties.displayName}
        </div>
      )}
    </div>
  );
}
