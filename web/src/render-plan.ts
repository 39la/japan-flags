import {
  flagRenderLod,
  DIRECT_RASTER_MIN_BUCKET,
  PREFECTURE_ATLAS_BUCKET,
  type RasterBucket,
} from "./flag-render-lod";
import { getFlagFitStrategy, placeMotif, type MotifPlacementOptions } from "./flag-fit";
import { rasterKey, type SpriteEntry, type RasterRequest } from "./flag-resources";
import { MAP_HEIGHT, MAP_WIDTH } from "./map-model";
import type { RenderedFeature } from "./map-geometry";
import type { FlagFitMode, MapFeature, ViewTransform } from "./types";
import {
  DEFAULT_MOTIF_RENDER_SETTINGS,
  motifPlacementForFlag,
  resolveFlagVisual,
  type FlagVisualEntry,
  type FlagVisualManifest,
  type MotifRenderSettings,
} from "./flag-visuals";

type DrawableFeature = RenderedFeature & {
  canvasPath: Path2D;
};

export type PlannedFeature = {
  item: DrawableFeature;
  hasFlag: boolean;
  resourcePath: string | null;
  visual: FlagVisualEntry | null;
  motifPlacement: MotifPlacementOptions | null;
  rasterBucket: RasterBucket | null;
  useDirectSvg: boolean;
  pixelSize: number;
};

export type RenderLayout = {
  features: PlannedFeature[];
};

export type RenderPlan = {
  features: PlannedFeature[];
  rasterRequests: RasterRequest[];
  svgRequests: string[];
  prefectureAtlasRequests: string[];
  resourceSignature: string;
};

export type BuildRenderPlanOptions = {
  items: RenderedFeature[];
  camera: ViewTransform;
  renderScale: number;
  fitMode: FlagFitMode;
  spriteEntries?: Record<string, SpriteEntry>;
  focusedPrefecture: string | null;
  spriteAtlasFailed: boolean;
  marginX?: number;
  marginY?: number;
  flagVisualManifest?: FlagVisualManifest | null;
  motifSettings?: MotifRenderSettings;
};

export type BuildRenderLayoutOptions = Omit<
  BuildRenderPlanOptions,
  "camera" | "marginX" | "marginY" | "spriteAtlasFailed"
>;

export type BuildRenderPlanFromLayoutOptions = {
  camera: ViewTransform;
  spriteAtlasFailed: boolean;
  marginX?: number;
  marginY?: number;
};

export function featureKey(feature: MapFeature) {
  return feature.properties.entityType === "prefecture"
    ? feature.properties.mapPart
    : `territory:${feature.properties.territoryVersionId}`;
}

export function prefectureCode(feature: MapFeature) {
  return feature.properties.entityType === "prefecture"
    ? feature.properties.prefectureCode
    : (feature.properties.prefectureCode ?? feature.properties.jis5.slice(0, 2));
}

export function isVisible(
  bounds: [[number, number], [number, number]],
  transform: ViewTransform,
  marginX = 0,
  marginY = 0,
) {
  const [[x0, y0], [x1, y1]] = bounds;
  return !(
    x1 * transform.k + transform.x < -marginX ||
    y1 * transform.k + transform.y < -marginY ||
    x0 * transform.k + transform.x > MAP_WIDTH + marginX ||
    y0 * transform.k + transform.y > MAP_HEIGHT + marginY
  );
}

export function buildRenderLayout({
  items,
  renderScale,
  fitMode,
  spriteEntries,
  focusedPrefecture,
  flagVisualManifest = null,
  motifSettings = DEFAULT_MOTIF_RENDER_SETTINGS,
}: BuildRenderLayoutOptions): RenderLayout {
  const features: PlannedFeature[] = [];
  const strategy = getFlagFitStrategy(fitMode === "motif" ? "cover" : fitMode);

  for (const item of items) {
    if (!item.canvasPath) {
      continue;
    }
    const flagPath = item.feature.properties.flagPath;
    const hasFlag = Boolean(
      flagPath && (!focusedPrefecture || prefectureCode(item.feature) === focusedPrefecture),
    );
    let rasterBucket: RasterBucket | null = null;
    let useDirectSvg = false;
    let resourcePath: string | null = flagPath;
    let visual: FlagVisualEntry | null = null;
    let motifPlacement: MotifPlacementOptions | null = null;
    let pixelSize = 0;

    if (hasFlag && flagPath) {
      visual = resolveFlagVisual(flagVisualManifest, flagPath);
      const separatedVisual = fitMode === "motif" && visual.kind === "separated" ? visual : null;
      resourcePath = separatedVisual?.motifPath ?? flagPath;
      if (separatedVisual) {
        motifPlacement = motifPlacementForFlag(
          motifSettings,
          item.feature.properties.flagPageId,
          separatedVisual,
        );
      }
      const [[x0, y0], [x1, y1]] = item.bounds;
      const sprite = spriteEntries?.[resourcePath];
      const imageWidth =
        sprite?.width ??
        (separatedVisual ? separatedVisual.motifAspectRatio : Math.max(1, x1 - x0));
      const imageHeight = sprite?.height ?? (separatedVisual ? 1 : Math.max(1, y1 - y0));
      const placement =
        separatedVisual && motifPlacement
          ? placeMotif(
              imageWidth,
              imageHeight,
              item.bounds,
              item.feature.properties.visualAnchor,
              item.feature.properties.visualSafeRadiusRatio,
              motifPlacement,
              item.feature.properties.visualCentroidAnchor,
              item.feature.properties.visualOptimizedAnchor,
              item.feature.properties.visualComponentBounds,
            )
          : strategy.place(imageWidth, imageHeight, item.bounds);
      pixelSize = Math.max(placement.width, placement.height) * renderScale;
      const lod = flagRenderLod(pixelSize);
      rasterBucket = lod.rasterBucket;
      useDirectSvg = lod.useDirectSvg;
    }

    features.push({
      item: item as DrawableFeature,
      hasFlag,
      resourcePath,
      visual,
      motifPlacement,
      rasterBucket,
      useDirectSvg,
      pixelSize,
    });
  }

  return { features };
}

export function buildRenderPlanFromLayout(
  layout: RenderLayout,
  { camera, spriteAtlasFailed, marginX = 0, marginY = 0 }: BuildRenderPlanFromLayoutOptions,
): RenderPlan {
  const features: PlannedFeature[] = [];
  const candidates: Array<{
    path: string;
    prefectureCode: string;
    pixelSize: number;
    bucket: RasterBucket;
    useDirectSvg: boolean;
  }> = [];
  const backgroundSvgRequests = new Set<string>();

  for (const planned of layout.features) {
    if (!isVisible(planned.item.bounds, camera, marginX, marginY)) continue;
    features.push(planned);
    if (planned.hasFlag && planned.resourcePath && planned.rasterBucket) {
      candidates.push({
        path: planned.resourcePath,
        prefectureCode: prefectureCode(planned.item.feature),
        pixelSize: planned.pixelSize,
        bucket: planned.rasterBucket,
        useDirectSvg: planned.useDirectSvg,
      });
    }
    if (planned.visual?.kind === "separated" && planned.visual.background.kind === "asset") {
      backgroundSvgRequests.add(planned.visual.background.path);
    }
  }

  const rasterRequests = new Map<string, RasterRequest>();
  const svgRequests = new Set<string>();
  const prefectureAtlasRequests = new Set<string>();
  candidates.sort((left, right) => right.pixelSize - left.pixelSize);
  for (const candidate of candidates) {
    if (candidate.useDirectSvg) svgRequests.add(candidate.path);
    if (candidate.bucket === PREFECTURE_ATLAS_BUCKET && candidate.prefectureCode) {
      prefectureAtlasRequests.add(candidate.prefectureCode);
    }
    if (candidate.bucket < DIRECT_RASTER_MIN_BUCKET && !spriteAtlasFailed) {
      continue;
    }
    const key = rasterKey(candidate.path, candidate.bucket);
    rasterRequests.set(key, {
      key,
      path: candidate.path,
      bucket: candidate.bucket,
    });
  }
  for (const path of backgroundSvgRequests) svgRequests.add(path);

  const rasterRequestList = [...rasterRequests.values()];
  const svgRequestList = [...svgRequests];
  const prefectureAtlasRequestList = [...prefectureAtlasRequests];
  return {
    features,
    rasterRequests: rasterRequestList,
    svgRequests: svgRequestList,
    prefectureAtlasRequests: prefectureAtlasRequestList,
    resourceSignature: [
      rasterRequestList.map((request) => request.key).join(","),
      svgRequestList.join(","),
      prefectureAtlasRequestList.join(","),
    ].join("|"),
  };
}

export function buildRenderPlan(options: BuildRenderPlanOptions): RenderPlan {
  const { camera, spriteAtlasFailed, marginX, marginY, ...layoutOptions } = options;
  return buildRenderPlanFromLayout(buildRenderLayout(layoutOptions), {
    camera,
    spriteAtlasFailed,
    marginX,
    marginY,
  });
}
