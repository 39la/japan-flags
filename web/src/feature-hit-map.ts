import type { RenderedFeature } from "./map-geometry";
import { MAP_HEIGHT, MAP_WIDTH } from "./map-model";
import type { MapFeature } from "./types";

// A 1.5x map keeps pointer hit testing precise enough while reducing the
// backing RGBA buffer from ~11.6 MiB to ~6.5 MiB.
const HIT_MAP_SCALE = 1.5;
const HIT_MAP_BUILD_SLICE_MS = 8;

export type FeatureHitMap = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  features: MapFeature[];
  scale: number;
};

function hitColor(index: number) {
  const id = index + 1;
  return `rgb(${id & 0xff}, ${(id >> 8) & 0xff}, ${(id >> 16) & 0xff})`;
}

function createHitMapCanvas() {
  if (typeof Path2D === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(MAP_WIDTH * HIT_MAP_SCALE);
  canvas.height = Math.ceil(MAP_HEIGHT * HIT_MAP_SCALE);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.setTransform(HIT_MAP_SCALE, 0, 0, HIT_MAP_SCALE, 0, 0);
  return { canvas, context };
}

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

export function buildFeatureHitMap(items: RenderedFeature[]): FeatureHitMap | null {
  const hitMap = createHitMapCanvas();
  if (!hitMap) return null;
  const { canvas, context } = hitMap;
  const features: MapFeature[] = [];
  for (const item of items) {
    if (!item.canvasPath) continue;
    context.fillStyle = hitColor(features.length);
    context.fill(item.canvasPath);
    features.push(item.feature);
  }
  return { canvas, context, features, scale: HIT_MAP_SCALE };
}

export async function buildFeatureHitMapAsync(
  items: RenderedFeature[],
  isCancelled: () => boolean,
): Promise<FeatureHitMap | null> {
  const hitMap = createHitMapCanvas();
  if (!hitMap) return null;
  const { canvas, context } = hitMap;
  const features: MapFeature[] = [];
  let sliceStart = performance.now();
  for (const item of items) {
    if (isCancelled()) return null;
    if (!item.canvasPath) continue;
    context.fillStyle = hitColor(features.length);
    context.fill(item.canvasPath);
    features.push(item.feature);
    if (performance.now() - sliceStart >= HIT_MAP_BUILD_SLICE_MS) {
      await yieldToBrowser();
      sliceStart = performance.now();
    }
  }
  if (isCancelled()) return null;
  return { canvas, context, features, scale: HIT_MAP_SCALE };
}

export function hitTestFeature(map: FeatureHitMap, worldX: number, worldY: number) {
  const x = Math.floor(worldX * map.scale);
  const y = Math.floor(worldY * map.scale);
  if (x < 0 || y < 0 || x >= map.canvas.width || y >= map.canvas.height) return null;
  const pixel = map.context.getImageData(x, y, 1, 1).data;
  const id = pixel[0] | (pixel[1] << 8) | (pixel[2] << 16);
  return id > 0 ? (map.features[id - 1] ?? null) : null;
}
