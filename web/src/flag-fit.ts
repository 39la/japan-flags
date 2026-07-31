import type { FlagFitMode } from "./types";

export type FlagPlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MotifPlacementOptions = {
  anchorMode: "incenter" | "centroid" | "hybrid" | "optimized";
  anchorBias: number;
  motifScale: number;
  overflow: number;
  edgePadding: number;
  minSizeRatio: number;
  maxSizeRatio: number;
  anchorOffsetX: number;
  anchorOffsetY: number;
};

export const DEFAULT_MOTIF_PLACEMENT: MotifPlacementOptions = {
  anchorMode: "incenter",
  anchorBias: 1,
  motifScale: 0.9,
  overflow: 0,
  edgePadding: 0.08,
  minSizeRatio: 0.12,
  maxSizeRatio: 0.7,
  anchorOffsetX: 0,
  anchorOffsetY: 0,
};

export type FlagFitStrategy = {
  id: FlagFitMode;
  place: (
    imageWidth: number,
    imageHeight: number,
    bounds: [[number, number], [number, number]],
  ) => FlagPlacement;
};

function dimensions(bounds: [[number, number], [number, number]]) {
  const [[x0, y0], [x1, y1]] = bounds;
  return {
    x0,
    y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
  };
}

const stretch: FlagFitStrategy = {
  id: "stretch",
  place: (_imageWidth, _imageHeight, bounds) => {
    const { x0, y0, width, height } = dimensions(bounds);
    return { x: x0, y: y0, width, height };
  },
};

function aspectPlacement(
  mode: "cover" | "contain",
  imageWidth: number,
  imageHeight: number,
  bounds: [[number, number], [number, number]],
): FlagPlacement {
  const { x0, y0, width, height } = dimensions(bounds);
  const imageRatio = Math.max(1, imageWidth) / Math.max(1, imageHeight);
  const boundsRatio = width / height;
  const useWidth = mode === "cover" ? boundsRatio >= imageRatio : boundsRatio <= imageRatio;
  const placedWidth = useWidth ? width : height * imageRatio;
  const placedHeight = useWidth ? width / imageRatio : height;
  return {
    x: x0 + (width - placedWidth) / 2,
    y: y0 + (height - placedHeight) / 2,
    width: placedWidth,
    height: placedHeight,
  };
}

const cover: FlagFitStrategy = {
  id: "cover",
  place: (imageWidth, imageHeight, bounds) =>
    aspectPlacement("cover", imageWidth, imageHeight, bounds),
};

const contain: FlagFitStrategy = {
  id: "contain",
  place: (imageWidth, imageHeight, bounds) =>
    aspectPlacement("contain", imageWidth, imageHeight, bounds),
};

export function placeMotif(
  imageWidth: number,
  imageHeight: number,
  bounds: [[number, number], [number, number]],
  anchor: [number, number] | null | undefined,
  safeRadiusRatio: number | null | undefined,
  options: MotifPlacementOptions,
  centroidAnchor?: [number, number] | null,
  optimizedAnchor?: [number, number] | null,
  componentBounds?: [number, number, number, number] | null,
): FlagPlacement {
  const { x0, y0, width, height } = dimensions(bounds);
  const normalizedComponent = componentBounds ?? [0, 0, 1, 1];
  const componentWidth = Math.max(0.01, (normalizedComponent[2] - normalizedComponent[0]) * width);
  const componentHeight = Math.max(
    0.01,
    (normalizedComponent[3] - normalizedComponent[1]) * height,
  );
  const minimumDimension = Math.min(componentWidth, componentHeight);
  const poleX = x0 + width * (anchor?.[0] ?? 0.5);
  const poleY = y0 + height * (anchor?.[1] ?? 0.5);
  const centroidX = x0 + width * (centroidAnchor?.[0] ?? 0.5);
  const centroidY = y0 + height * (centroidAnchor?.[1] ?? 0.5);
  const optimizedX = x0 + width * (optimizedAnchor?.[0] ?? anchor?.[0] ?? 0.5);
  const optimizedY = y0 + height * (optimizedAnchor?.[1] ?? anchor?.[1] ?? 0.5);
  const bias = Math.max(0, Math.min(1, options.anchorBias));
  const [baseX, baseY] = (() => {
    switch (options.anchorMode) {
      case "centroid":
        return [centroidX, centroidY];
      case "hybrid":
        return [centroidX + (poleX - centroidX) * bias, centroidY + (poleY - centroidY) * bias];
      case "optimized":
        return [optimizedX, optimizedY];
      default:
        return [poleX, poleY];
    }
  })();
  const targetX = baseX + options.anchorOffsetX * minimumDimension;
  const targetY = baseY + options.anchorOffsetY * minimumDimension;
  const radius = Math.max(0.01, safeRadiusRatio ?? 0.5) * Math.min(width, height);
  const usableDiameter =
    2 *
    radius *
    Math.max(0.05, options.motifScale) *
    (1 + Math.max(0, options.overflow)) *
    (1 - Math.max(0, Math.min(0.49, options.edgePadding)));
  const aspect = Math.max(0.01, imageWidth) / Math.max(0.01, imageHeight);
  let placedHeight = usableDiameter / Math.sqrt(aspect * aspect + 1);
  let placedWidth = placedHeight * aspect;
  const longSide = Math.max(placedWidth, placedHeight);
  const minimumSize = Math.max(0, options.minSizeRatio) * minimumDimension;
  const maximumSize = Math.max(options.minSizeRatio, options.maxSizeRatio) * minimumDimension;
  const clampedLongSide = Math.min(maximumSize, Math.max(minimumSize, longSide));
  const scale = clampedLongSide / Math.max(0.01, longSide);
  placedWidth *= scale;
  placedHeight *= scale;
  return {
    x: targetX - placedWidth / 2,
    y: targetY - placedHeight / 2,
    width: placedWidth,
    height: placedHeight,
  };
}

const motif: FlagFitStrategy = {
  id: "motif",
  place: (imageWidth, imageHeight, bounds) =>
    placeMotif(imageWidth, imageHeight, bounds, null, null, DEFAULT_MOTIF_PLACEMENT),
};

const strategies: Record<FlagFitMode, FlagFitStrategy> = {
  cover,
  contain,
  stretch,
  motif,
};

export function getFlagFitStrategy(mode: FlagFitMode): FlagFitStrategy {
  return strategies[mode] ?? strategies.cover;
}
