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
import {
  createSceneCache,
  drawCachedScene,
  drawMapOverlay,
  drawPrefectureBoundaries,
  drawRenderPlanFeatures,
  drawSceneBoundaries,
  resizeVisibleCanvases,
  type SceneCache,
} from "./canvas-renderer";
import { buildFeatureHitMapAsync, hitTestFeature, type FeatureHitMap } from "./feature-hit-map";
import {
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
import {
  focusFeatureCamera,
  nationalView,
  sceneCacheContainsViewport,
  zoomCamera,
} from "./map-camera";
import { exportCamera, type MapExportRequest } from "./map-export";
import { useCompiledMapScene } from "./map-geometry";
import { MAP_HEIGHT, MAP_WIDTH } from "./map-model";
import {
  buildRenderLayout,
  buildRenderPlanFromLayout,
  featureKey,
  isVisible,
  prefectureCode,
  type RenderLayout,
  type RenderPlan,
} from "./render-plan";
import { geometryLodForRenderScale, physicalRenderScale, type GeometryLod } from "./render-scale";
import { buildMapSvg } from "./svg-renderer";
import type { FlagFitMode, MapDisplayOptions, MapFeature, MapLayer, ViewTransform } from "./types";
import { createWebGLMapRenderer, type WebGLMapRenderer } from "./webgl-renderer";

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

const SCENE_OVERSCAN = 1.6;
const CAMERA_SETTLE_MS = 120;
const DETAIL_PREFETCH_MARGIN = 160;
const EMPTY_BOUNDARY_FEATURES: MapFeature[] = [];

type InteractionViewport = {
  left: number;
  top: number;
  viewport: ReturnType<typeof fitCanvasViewport>;
};

function canvasPoint(measurement: InteractionViewport, clientX: number, clientY: number) {
  return viewportPointToContent(
    measurement.viewport,
    clientX - measurement.left,
    clientY - measurement.top,
  );
}

function scenePixelRatio() {
  return window.devicePixelRatio || 1;
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
  const hoveredPrefectureCode =
    layer === "prefecture" && displayOptions.showMunicipalityBoundariesOnPrefectureHover && hovered
      ? prefectureCode(hovered)
      : null;
  const municipalityHoverFeatures = useMemo(
    () =>
      hoveredPrefectureCode
        ? municipalityBoundaryFeatures.filter(
            (feature) => prefectureCode(feature) === hoveredPrefectureCode,
          )
        : EMPTY_BOUNDARY_FEATURES,
    [hoveredPrefectureCode, municipalityBoundaryFeatures],
  );
  const { renderedBoundaries: prefectureOverlayBoundaries, ready: prefectureOverlayReady } =
    useCompiledMapScene(prefectureOverlayFeatures, "prefecture", projection, false);
  const { renderedBoundaries: municipalityHoverBoundaries } = useCompiledMapScene(
    municipalityHoverFeatures,
    "municipality",
    projection,
    false,
  );
  const staticPrefectureBoundaries =
    layer === "municipality" && displayOptions.showPrefectureBoundaries
      ? prefectureOverlayBoundaries
      : null;
  const [spriteAtlas, setSpriteAtlas] = useState<SpriteAtlas | null>(null);
  const [spriteAtlasFailed, setSpriteAtlasFailed] = useState(false);
  const [spriteAtlasSettled, setSpriteAtlasSettled] = useState(false);
  const [flagVisualManifest, setFlagVisualManifest] = useState<FlagVisualManifest | null>(null);
  const [flagVisualManifestSettled, setFlagVisualManifestSettled] = useState(false);
  const [exportReady, setExportReady] = useState(false);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const webglCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const webglRendererRef = useRef<WebGLMapRenderer | null>(null);
  const sceneCacheRef = useRef<SceneCache | null>(null);
  const hitMapRef = useRef<FeatureHitMap | null>(null);
  const interactionViewportRef = useRef<InteractionViewport | null>(null);
  const renderLayoutCacheRef = useRef<{
    generation: number;
    renderScale: number;
    fitMode: FlagFitMode;
    focusedPrefecture: string | null;
    spriteAtlas: SpriteAtlas | null;
    flagVisualManifest: FlagVisualManifest | null;
    motifSettingsSignature: string;
    layout: RenderLayout;
  } | null>(null);
  const prefetchPlanCacheRef = useRef<{
    layout: RenderLayout;
    camera: ViewTransform;
    plan: RenderPlan;
  } | null>(null);
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
  const motifSettingsSignature = useMemo(() => JSON.stringify(motifSettings), [motifSettings]);

  useEffect(() => {
    sceneCacheRef.current = createSceneCache(
      layer,
      fitMode,
      focusedPrefecture,
      motifSettingsSignature,
    );
    return () => {
      if (cameraFrameRef.current !== null) {
        window.cancelAnimationFrame(cameraFrameRef.current);
      }
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      resourceBatchGenerationRef.current += 1;
      webglRendererRef.current?.dispose();
      webglRendererRef.current = null;
      sceneCacheRef.current = null;
      hitMapRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    hitMapRef.current = null;
    void buildFeatureHitMapAsync(renderedFeatures, () => cancelled).then((map) => {
      if (!cancelled) hitMapRef.current = map;
    });
    return () => {
      cancelled = true;
      hitMapRef.current = null;
    };
  }, [renderedFeatures]);

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
    [renderedFeatures, onVisiblePrefecturesChange],
  );

  const getRenderLayout = useCallback(
    (renderScale: number) => {
      const cached = renderLayoutCacheRef.current;
      if (
        cached?.generation === sceneGeneration &&
        cached.renderScale === renderScale &&
        cached.fitMode === fitMode &&
        cached.focusedPrefecture === focusedPrefecture &&
        cached.spriteAtlas === spriteAtlas &&
        cached.flagVisualManifest === flagVisualManifest &&
        cached.motifSettingsSignature === motifSettingsSignature
      ) {
        return cached.layout;
      }
      const layout = buildRenderLayout({
        items: renderedFeatures,
        renderScale,
        fitMode,
        spriteEntries: spriteAtlas?.sprites,
        focusedPrefecture,
        flagVisualManifest,
        motifSettings,
      });
      renderLayoutCacheRef.current = {
        generation: sceneGeneration,
        renderScale,
        fitMode,
        focusedPrefecture,
        spriteAtlas,
        flagVisualManifest,
        motifSettingsSignature,
        layout,
      };
      prefetchPlanCacheRef.current = null;
      return layout;
    },
    [
      fitMode,
      focusedPrefecture,
      flagVisualManifest,
      motifSettings,
      motifSettingsSignature,
      renderedFeatures,
      sceneGeneration,
      spriteAtlas,
    ],
  );

  const ensureVisibleCanvasSizes = useCallback(() => {
    return resizeVisibleCanvases(baseCanvasRef.current, overlayCanvasRef.current);
  }, []);

  const renderVectorScene = useCallback(
    (camera: ViewTransform) => {
      const visibleCanvas = baseCanvasRef.current;
      const cache = sceneCacheRef.current;
      if (!visibleCanvas || !cache || typeof Path2D === "undefined") {
        return false;
      }
      ensureVisibleCanvasSizes();
      const webglCanvas = webglCanvasRef.current;
      if (webglCanvas && !webglRendererRef.current) {
        webglRendererRef.current = createWebGLMapRenderer(webglCanvas);
      }
      const width = Math.max(1, visibleCanvas.clientWidth);
      const height = Math.max(1, visibleCanvas.clientHeight);
      const ratio = scenePixelRatio();
      const viewport = fitCanvasViewport(
        visibleCanvas.width,
        visibleCanvas.height,
        MAP_WIDTH,
        MAP_HEIGHT,
      );
      const maxSize = webglRendererRef.current?.maxSize ?? Number.POSITIVE_INFINITY;
      const paddingX = Math.min(
        Math.round(((SCENE_OVERSCAN - 1) * MAP_WIDTH * viewport.scale) / 2),
        Math.max(0, Math.floor((maxSize - visibleCanvas.width) / 2)),
      );
      const paddingY = Math.min(
        Math.round(((SCENE_OVERSCAN - 1) * MAP_HEIGHT * viewport.scale) / 2),
        Math.max(0, Math.floor((maxSize - visibleCanvas.height) / 2)),
      );
      const marginX = (viewport.offsetX + paddingX) / viewport.scale;
      const marginY = (viewport.offsetY + paddingY) / viewport.scale;
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
      const plan = buildRenderPlanFromLayout(getRenderLayout(renderScale), {
        camera,
        spriteAtlasFailed,
        marginX,
        marginY,
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
        void Promise.all(pendingResources).then((results) => {
          if (resourceBatchGenerationRef.current === resourceGeneration) {
            resourceBatchPendingRef.current = false;
            if (results.some(Boolean)) resourceRevisionRef.current += 1;
            scheduleSettledRef.current(0);
          }
        });
      }

      const webglRenderer = webglRendererRef.current;
      if (webglRenderer) {
        if (webglCanvas) {
          if (webglCanvas.width !== targetWidth) webglCanvas.width = targetWidth;
          if (webglCanvas.height !== targetHeight) webglCanvas.height = targetHeight;
        }
        webglRenderer.setScene(plan.features, renderedBoundaries);
        webglRenderer.draw(camera, {
          ...viewport,
          offsetX: marginX * viewport.scale,
          offsetY: marginY * viewport.scale,
        });
        // GPUと旗は同じoverscan・cameraを共有し、操作中は合成だけを行う。
        drawRenderPlanFeatures(context, plan, fitMode, spriteAtlas, { fillPolygons: false });
      } else {
        drawRenderPlanFeatures(context, plan, fitMode, spriteAtlas);
      }
      if (!webglRenderer) {
        drawSceneBoundaries(context, renderedBoundaries, camera, marginX, marginY);
      }

      if (staticPrefectureBoundaries) {
        drawPrefectureBoundaries(context, staticPrefectureBoundaries, camera, marginX, marginY);
      }
      cache.prefectureBoundaries = staticPrefectureBoundaries;
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
      getRenderLayout,
      layer,
      motifSettingsSignature,
      renderedBoundaries,
      staticPrefectureBoundaries,
      sceneGeneration,
      spriteAtlas,
      spriteAtlasFailed,
      onGeometryLodChange,
      exportRequest,
      ensureVisibleCanvasSizes,
    ],
  );

  const updateInteractionViewport = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const measurement = {
      left: rect.left,
      top: rect.top,
      viewport: fitCanvasViewport(rect.width, rect.height, MAP_WIDTH, MAP_HEIGHT),
    };
    interactionViewportRef.current = measurement;
    return measurement;
  }, []);

  const drawCachedBase = useCallback(() => {
    const canvas = baseCanvasRef.current;
    const cache = sceneCacheRef.current;
    if (!canvas || !cache || !cache.canvas.width) return;
    ensureVisibleCanvasSizes();
    const webglCanvas = webglCanvasRef.current;
    if (webglCanvas && webglRendererRef.current) {
      const viewport = fitCanvasViewport(canvas.width, canvas.height, MAP_WIDTH, MAP_HEIGHT);
      const camera = cameraRef.current;
      const scale = camera.k / cache.camera.k;
      const x = camera.x - scale * (cache.camera.x + cache.marginX);
      const y = camera.y - scale * (cache.camera.y + cache.marginY);
      const ratio = window.devicePixelRatio || 1;
      webglCanvas.style.width = `${webglCanvas.width / ratio}px`;
      webglCanvas.style.height = `${webglCanvas.height / ratio}px`;
      webglCanvas.style.transformOrigin = "0 0";
      webglCanvas.style.transform = `translate(${(viewport.offsetX + x * viewport.scale) / ratio}px, ${(viewport.offsetY + y * viewport.scale) / ratio}px) scale(${scale})`;
    }
    drawCachedScene(canvas, cache, cameraRef.current);
  }, [ensureVisibleCanvasSizes]);
  drawCachedBaseRef.current = drawCachedBase;

  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || typeof Path2D === "undefined") return;
    ensureVisibleCanvasSizes();
    drawMapOverlay({
      prefectureBoundariesCached:
        staticPrefectureBoundaries !== null &&
        sceneCacheRef.current?.prefectureBoundaries === staticPrefectureBoundaries,
      canvas,
      camera: cameraRef.current,
      layer,
      displayOptions,
      hovered,
      selected,
      renderedFeatures,
      prefectureBoundaries: prefectureOverlayBoundaries,
      municipalityBoundaries: municipalityHoverBoundaries,
    });
  }, [
    displayOptions.showMunicipalityBoundariesOnPrefectureHover,
    displayOptions.showPrefectureBoundaries,
    ensureVisibleCanvasSizes,
    hovered,
    layer,
    municipalityHoverBoundaries,
    prefectureOverlayBoundaries,
    staticPrefectureBoundaries,
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
      const ratio = scenePixelRatio();
      const visiblePixelWidth = Math.round(Math.max(1, canvas.clientWidth) * ratio);
      const visiblePixelHeight = Math.round(Math.max(1, canvas.clientHeight) * ratio);
      return (
        cache.prefectureBoundaries === staticPrefectureBoundaries &&
        cache.sceneGeneration === sceneGeneration &&
        cache.resourceRevision === resourceRevisionRef.current &&
        cache.layer === layer &&
        cache.fitMode === fitMode &&
        cache.focusedPrefecture === focusedPrefecture &&
        cache.motifSettingsSignature === motifSettingsSignature &&
        sceneCacheContainsViewport(cache, camera, visiblePixelWidth, visiblePixelHeight)
      );
    },
    [
      fitMode,
      focusedPrefecture,
      layer,
      motifSettingsSignature,
      sceneGeneration,
      staticPrefectureBoundaries,
    ],
  );

  const renderSettled = useCallback(() => {
    const camera = cameraRef.current;
    const cache = sceneCacheRef.current;
    const gpuAligned =
      !webglRendererRef.current || (cache?.camera.x === camera.x && cache.camera.y === camera.y);
    if (canReuseCachedScene(camera) && gpuAligned) {
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
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const ratio = scenePixelRatio();
      const viewport = fitCanvasViewport(width * ratio, height * ratio, MAP_WIDTH, MAP_HEIGHT);
      const layout = getRenderLayout(physicalRenderScale(viewport.scale, camera.k));
      const cached = prefetchPlanCacheRef.current;
      const plan =
        cached?.layout === layout &&
        cached.camera.k === camera.k &&
        Math.abs(cached.camera.x - camera.x) <= DETAIL_PREFETCH_MARGIN / 2 &&
        Math.abs(cached.camera.y - camera.y) <= DETAIL_PREFETCH_MARGIN / 2
          ? cached.plan
          : buildRenderPlanFromLayout(layout, {
              camera,
              spriteAtlasFailed,
              marginX: DETAIL_PREFETCH_MARGIN,
              marginY: DETAIL_PREFETCH_MARGIN,
            });
      if (plan !== cached?.plan) {
        prefetchPlanCacheRef.current = { layout, camera: { ...camera }, plan };
      }
      if (plan.resourceSignature === resourceIntentSignatureRef.current) return;
      resourceIntentSignatureRef.current = plan.resourceSignature;
      void prefetchFlagResources(plan.rasterRequests, plan.svgRequests);
      for (const code of plan.prefectureAtlasRequests) {
        void preloadPrefectureSpriteAtlas(code);
      }
    },
    [getRenderLayout, renderedFeatures, spriteAtlasFailed],
  );

  const queueCameraFrame = useCallback(() => {
    if (cameraFrameRef.current !== null) return;
    cameraFrameRef.current = window.requestAnimationFrame(() => {
      cameraFrameRef.current = null;
      ensureVisibleCanvasSizes();
      const canvas = baseCanvasRef.current;
      const cache = sceneCacheRef.current;
      if (
        canvas &&
        cache &&
        !sceneCacheContainsViewport(cache, cameraRef.current, canvas.width, canvas.height, true)
      ) {
        renderVectorScene(cameraRef.current);
      }
      drawCachedBaseRef.current();
      drawOverlayRef.current();
      prefetchCameraResources(cameraRef.current);
    });
  }, [prefetchCameraResources, ensureVisibleCanvasSizes, renderVectorScene]);

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
    updateInteractionViewport();
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateInteractionViewport();
      renderSettledRef.current();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [updateInteractionViewport]);

  const zoom = (factor: number) => {
    setCamera(zoomCamera(cameraRef.current, factor));
  };

  const hitTest = (clientX: number, clientY: number) => {
    const hitMap = hitMapRef.current;
    const measurement = interactionViewportRef.current ?? updateInteractionViewport();
    if (!hitMap || !measurement) return null;
    const point = canvasPoint(measurement, clientX, clientY);
    const camera = cameraRef.current;
    const worldX = (point.x - camera.x) / camera.k;
    const worldY = (point.y - camera.y) / camera.k;
    try {
      return hitTestFeature(hitMap, worldX, worldY);
    } catch {
      return null;
    }
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
    const viewport =
      (interactionViewportRef.current ?? updateInteractionViewport())?.viewport ??
      fitCanvasViewport(1, 1, MAP_WIDTH, MAP_HEIGHT);
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
      <canvas ref={webglCanvasRef} className="map-canvas map-webgl-canvas" aria-hidden="true" />
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
