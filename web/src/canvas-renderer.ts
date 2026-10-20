import { fitCanvasViewport } from "./canvas-viewport";
import {
  getFlagFitStrategy,
  placeMotif,
  type FlagFitStrategy,
  type FlagPlacement,
} from "./flag-fit";
import {
  cachedFlagRaster,
  cachedFlagSvg,
  cachedPrefectureSpriteAtlas,
  type SpriteEntry,
  type SpriteAtlas,
} from "./flag-resources";
import { nationalView } from "./map-camera";
import type { RenderedBoundary, RenderedFeature } from "./map-geometry";
import { MAP_HEIGHT, MAP_WIDTH } from "./map-model";
import {
  featureKey,
  isVisible,
  prefectureCode,
  type PlannedFeature,
  type RenderPlan,
} from "./render-plan";
import type { FlagFitMode, MapDisplayOptions, MapFeature, MapLayer, ViewTransform } from "./types";

export type SceneCache = {
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

export function createSceneCache(
  layer: MapLayer,
  fitMode: FlagFitMode,
  focusedPrefecture: string | null,
  motifSettingsSignature: string,
): SceneCache {
  return {
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
}

export function resizeVisibleCanvases(
  base: HTMLCanvasElement | null,
  overlay: HTMLCanvasElement | null,
  webgl: HTMLCanvasElement | null = null,
) {
  if (!base || !overlay) return false;
  const width = Math.max(1, base.clientWidth);
  const height = Math.max(1, base.clientHeight);
  const ratio = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.round(width * ratio));
  const targetHeight = Math.max(1, Math.round(height * ratio));
  let resized = false;
  for (const canvas of [base, overlay, webgl]) {
    if (!canvas) continue;
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      resized = true;
    }
  }
  return resized;
}

export function drawCachedScene(
  canvas: HTMLCanvasElement,
  cache: SceneCache,
  camera: ViewTransform,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
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
  context.imageSmoothingQuality = cameraScale === 1 ? "high" : "low";
  context.drawImage(
    cache.canvas,
    -cache.marginX,
    -cache.marginY,
    cache.logicalWidth,
    cache.logicalHeight,
  );
}

function flagPlacement(
  planned: PlannedFeature,
  fitMode: FlagFitMode,
  strategy: FlagFitStrategy,
  width: number,
  height: number,
): FlagPlacement {
  const { item, visual, motifPlacement } = planned;
  const properties = item.feature.properties;
  if (fitMode === "motif" && visual?.kind === "separated" && motifPlacement) {
    return placeMotif(
      width,
      height,
      item.bounds,
      properties.visualAnchor,
      properties.visualSafeRadiusRatio,
      motifPlacement,
      properties.visualCentroidAnchor,
      properties.visualOptimizedAnchor,
      properties.visualComponentBounds,
    );
  }
  return strategy.place(width, height, item.bounds);
}

function drawImage(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  placement: FlagPlacement,
  source?: SpriteEntry,
  smooth = false,
) {
  if (smooth) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
  }
  if (source) {
    context.drawImage(
      image,
      source.x,
      source.y,
      source.width,
      source.height,
      placement.x,
      placement.y,
      placement.width,
      placement.height,
    );
  } else {
    context.drawImage(image, placement.x, placement.y, placement.width, placement.height);
  }
}

export function drawRenderPlanFeatures(
  context: CanvasRenderingContext2D,
  plan: RenderPlan,
  fitMode: FlagFitMode,
  spriteAtlas: SpriteAtlas | null,
  options: { fillPolygons?: boolean } = {},
) {
  const strategy = getFlagFitStrategy(fitMode === "motif" ? "cover" : fitMode);
  // Keep the cheap polygon fill pass free of clip/save/restore state changes.
  if (options.fillPolygons !== false) {
    for (const planned of plan.features) {
      const { item, hasFlag, visual, motifPlacement } = planned;
      const path = item.canvasPath;
      const separated =
        fitMode === "motif" && visual?.kind === "separated" && motifPlacement !== null;
      context.fillStyle =
        separated && visual.background.kind === "solid"
          ? visual.background.color
          : hasFlag
            ? "#ffffff"
            : "#edf0f2";
      context.fill(path);
    }
  }

  // A feature uses one clip for all of its image layers (background and flag).
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
    const separated =
      fitMode === "motif" && visual?.kind === "separated" && motifPlacement !== null;
    const background =
      separated && visual.background.kind === "asset"
        ? cachedFlagSvg(visual.background.path)
        : null;
    const showFlag = Boolean(hasFlag && resourcePath && bucket);

    let flagImage: CanvasImageSource | null = null;
    let flagSource: SpriteEntry | undefined;
    let flagPlacementValue: FlagPlacement | null = null;
    let smoothFlag = false;

    if (showFlag && resourcePath && bucket) {
      const svg = useDirectSvg ? cachedFlagSvg(resourcePath) : null;
      const raster = cachedFlagRaster(resourcePath, bucket);
      if (svg) {
        flagImage = svg.image;
        flagPlacementValue = flagPlacement(planned, fitMode, strategy, svg.width, svg.height);
        smoothFlag = true;
      } else if (raster) {
        flagImage = raster.bitmap;
        flagPlacementValue = flagPlacement(planned, fitMode, strategy, raster.width, raster.height);
      } else {
        const prefectureAtlas =
          bucket === 64 ? cachedPrefectureSpriteAtlas(prefectureCode(item.feature)) : null;
        const atlas = prefectureAtlas?.sprites[resourcePath] ? prefectureAtlas : spriteAtlas;
        const sprite = atlas?.sprites[resourcePath];
        if (sprite && atlas) {
          flagImage = atlas.image;
          flagSource = sprite;
          flagPlacementValue = flagPlacement(
            planned,
            fitMode,
            strategy,
            sprite.width,
            sprite.height,
          );
          smoothFlag = true;
        }
      }
    }

    if (!background && (!flagImage || !flagPlacementValue)) continue;
    context.save();
    context.clip(path);

    if (background) {
      const placement = getFlagFitStrategy("cover").place(
        background.width,
        background.height,
        item.bounds,
      );
      drawImage(context, background.image, placement);
    }
    if (flagImage && flagPlacementValue) {
      drawImage(context, flagImage, flagPlacementValue, flagSource, smoothFlag);
    }
    context.restore();
  }
}

export function drawSceneBoundaries(
  context: CanvasRenderingContext2D,
  boundaries: RenderedBoundary[],
  camera: ViewTransform,
  marginX: number,
  marginY: number,
) {
  context.strokeStyle = "#aeb6bc";
  context.lineWidth = 0.62 / camera.k;
  for (const boundary of boundaries) {
    if (boundary.canvasPaths.length && isVisible(boundary.bounds, camera, marginX, marginY)) {
      for (const path of boundary.canvasPaths) context.stroke(path);
    }
  }
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

type OverlayOptions = {
  canvas: HTMLCanvasElement;
  camera: ViewTransform;
  layer: MapLayer;
  displayOptions: MapDisplayOptions;
  hovered: MapFeature | null;
  selected: MapFeature | null;
  renderedFeatures: RenderedFeature[];
  prefectureBoundaries: RenderedBoundary[];
  municipalityBoundaries: RenderedBoundary[];
};

export function drawMapOverlay({
  canvas,
  camera,
  layer,
  displayOptions,
  hovered,
  selected,
  renderedFeatures,
  prefectureBoundaries,
  municipalityBoundaries,
}: OverlayOptions) {
  if (typeof Path2D === "undefined") return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const viewport = fitCanvasViewport(canvas.width, canvas.height, MAP_WIDTH, MAP_HEIGHT);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(viewport.scale, 0, 0, viewport.scale, viewport.offsetX, viewport.offsetY);
  context.translate(camera.x, camera.y);
  context.scale(camera.k, camera.k);

  if (layer === "municipality" && displayOptions.showPrefectureBoundaries) {
    strokeBoundaryLayer(context, prefectureBoundaries, camera, "#6f7980", 1.18);
  }
  if (
    layer === "prefecture" &&
    displayOptions.showMunicipalityBoundariesOnPrefectureHover &&
    hovered
  ) {
    strokeBoundaryLayer(context, municipalityBoundaries, camera, "#68737a", 0.72);
  }

  const selectedKey = selected ? featureKey(selected) : null;
  const hoveredKey = hovered ? featureKey(hovered) : null;
  const selectedIsPrefecture = selected?.properties.entityType === "prefecture";
  for (const item of renderedFeatures) {
    const itemKey = item.key ?? featureKey(item.feature);
    const itemIsPrefecture = item.feature.properties.entityType === "prefecture";
    const selectedFeature = selected
      ? itemIsPrefecture && selectedIsPrefecture
        ? item.feature.properties.prefectureCode === selected.properties.prefectureCode
        : itemKey === selectedKey
      : false;
    const hoveredFeature = hoveredKey !== null && itemKey === hoveredKey;
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
}
