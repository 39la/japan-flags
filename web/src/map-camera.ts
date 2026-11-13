import { focusBounds, MAP_HEIGHT, MAP_WIDTH } from "./map-model";
import { fitCanvasViewport } from "./canvas-viewport";
import { featureKey } from "./render-plan";
import type { RenderedFeature } from "./map-geometry";
import type { MapFeature, MapLayer, ViewTransform } from "./types";

export const NATIONAL_ZOOM = 1.08;
export const MAX_CAMERA_ZOOM = 24;

export const nationalView: ViewTransform = {
  x: MAP_WIDTH / 2 - (NATIONAL_ZOOM * MAP_WIDTH) / 2,
  y: MAP_HEIGHT / 2 - (NATIONAL_ZOOM * MAP_HEIGHT) / 2,
  k: NATIONAL_ZOOM,
};

export type SceneViewportCache = {
  camera: ViewTransform;
  marginX: number;
  marginY: number;
  visiblePixelWidth: number;
  visiblePixelHeight: number;
};

export function sceneCacheContainsViewport(
  cache: SceneViewportCache,
  camera: ViewTransform,
  visiblePixelWidth: number,
  visiblePixelHeight: number,
  allowScaling = false,
) {
  if (
    (!allowScaling && camera.k !== cache.camera.k) ||
    visiblePixelWidth !== cache.visiblePixelWidth ||
    visiblePixelHeight !== cache.visiblePixelHeight
  ) {
    return false;
  }
  const viewport = fitCanvasViewport(visiblePixelWidth, visiblePixelHeight, MAP_WIDTH, MAP_HEIGHT);
  const scale = camera.k / cache.camera.k;
  const x = camera.x - scale * cache.camera.x;
  const y = camera.y - scale * cache.camera.y;
  const marginX = viewport.offsetX / viewport.scale;
  const marginY = viewport.offsetY / viewport.scale;
  return (
    x - scale * cache.marginX <= -marginX + 0.000001 &&
    x + scale * (MAP_WIDTH + cache.marginX) >= MAP_WIDTH + marginX - 0.000001 &&
    y - scale * cache.marginY <= -marginY + 0.000001 &&
    y + scale * (MAP_HEIGHT + cache.marginY) >= MAP_HEIGHT + marginY - 0.000001
  );
}

export function featureIsSelected(feature: MapFeature, selected: MapFeature | null) {
  if (!selected) return false;
  if (
    feature.properties.entityType === "prefecture" &&
    selected.properties.entityType === "prefecture"
  ) {
    return feature.properties.prefectureCode === selected.properties.prefectureCode;
  }
  return featureKey(feature) === featureKey(selected);
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

export function zoomCamera(current: ViewTransform, factor: number): ViewTransform {
  const k = Math.max(NATIONAL_ZOOM, Math.min(MAX_CAMERA_ZOOM, current.k * factor));
  return {
    k,
    x: MAP_WIDTH / 2 - (k / current.k) * (MAP_WIDTH / 2 - current.x),
    y: MAP_HEIGHT / 2 - (k / current.k) * (MAP_HEIGHT / 2 - current.y),
  };
}
