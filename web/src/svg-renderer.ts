import { geoPath, type GeoProjection } from "d3-geo";
import { getFlagFitStrategy, placeMotif, type FlagPlacement } from "./flag-fit";
import type { SpriteEntry } from "./flag-resources";
import type { FlagVisualManifest, MotifRenderSettings } from "./flag-visuals";
import { MAP_HEIGHT, MAP_WIDTH } from "./map-model";
import {
  createProjectedArcStore,
  type RenderedBoundary,
  type RenderedFeature,
} from "./map-geometry";
import { buildRenderPlan } from "./render-plan";
import type { FlagFitMode, MapLayer, ViewTransform } from "./types";

export type EmbeddedSvgAsset = {
  dataUrl: string;
  width: number;
  height: number;
};

export type SvgMapOptions = {
  width: number;
  height: number;
  layer: MapLayer;
  fitMode: FlagFitMode;
  camera: ViewTransform;
  projection: GeoProjection;
  renderedFeatures: RenderedFeature[];
  renderedBoundaries: RenderedBoundary[];
  prefectureOverlayBoundaries: RenderedBoundary[];
  showPrefectureBoundaries: boolean;
  spriteEntries?: Record<string, SpriteEntry>;
  flagVisualManifest: FlagVisualManifest | null;
  motifSettings: MotifRenderSettings;
};

type AssetLoader = (path: string) => Promise<EmbeddedSvgAsset>;

const assetCache = new Map<string, Promise<EmbeddedSvgAsset>>();

function finiteDimension(value: string | null) {
  if (!value || value.endsWith("%")) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function svgDimensions(source: string) {
  const document_ = new DOMParser().parseFromString(source, "image/svg+xml");
  if (document_.querySelector("parsererror")) throw new Error("Invalid SVG asset");
  const root = document_.documentElement;
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
  const viewBoxWidth = viewBox?.length === 4 && Number.isFinite(viewBox[2]) ? viewBox[2] : null;
  const viewBoxHeight = viewBox?.length === 4 && Number.isFinite(viewBox[3]) ? viewBox[3] : null;
  return {
    width: finiteDimension(root.getAttribute("width")) ?? viewBoxWidth ?? 1,
    height: finiteDimension(root.getAttribute("height")) ?? viewBoxHeight ?? 1,
  };
}

function base64Svg(source: string) {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

async function loadEmbeddedSvg(path: string) {
  let pending = assetCache.get(path);
  if (!pending) {
    pending = fetch(path).then(async (response) => {
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      const source = await response.text();
      return { dataUrl: base64Svg(source), ...svgDimensions(source) };
    });
    assetCache.set(path, pending);
  }
  return pending;
}

function number(value: number) {
  return Number(value.toFixed(3));
}

function placementAttributes(placement: FlagPlacement) {
  return `x="${number(placement.x)}" y="${number(placement.y)}" width="${number(placement.width)}" height="${number(placement.height)}"`;
}

export function boundarySvgPath(boundaries: RenderedBoundary[], projection: GeoProjection) {
  const commands: string[] = [];
  for (const boundary of boundaries) {
    const store = createProjectedArcStore(boundary.source.source, projection);
    for (const arcIndex of boundary.source.arcIndexes) {
      const points = store.get(arcIndex);
      if (points.length < 2) continue;
      commands.push(`M${number(points[0][0])},${number(points[0][1])}`);
      for (let index = 1; index < points.length; index += 1) {
        commands.push(`L${number(points[index][0])},${number(points[index][1])}`);
      }
    }
  }
  return commands.join("");
}

async function loadAssets(paths: string[], loader: AssetLoader) {
  const assets = new Map<string, EmbeddedSvgAsset>();
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(12, paths.length) }, async () => {
    while (nextIndex < paths.length) {
      const path = paths[nextIndex];
      nextIndex += 1;
      try {
        assets.set(path, await loader(path));
      } catch {
        // The polygon background remains as the deterministic fallback.
      }
    }
  });
  await Promise.all(workers);
  return assets;
}

function imagePlacement(
  feature: ReturnType<typeof buildRenderPlan>["features"][number],
  asset: EmbeddedSvgAsset,
  fitMode: FlagFitMode,
) {
  const properties = feature.item.feature.properties;
  if (fitMode === "motif" && feature.visual?.kind === "separated" && feature.motifPlacement) {
    return placeMotif(
      asset.width,
      asset.height,
      feature.item.bounds,
      properties.visualAnchor,
      properties.visualSafeRadiusRatio,
      feature.motifPlacement,
      properties.visualCentroidAnchor,
      properties.visualOptimizedAnchor,
      properties.visualComponentBounds,
    );
  }
  return getFlagFitStrategy(fitMode === "motif" ? "cover" : fitMode).place(
    asset.width,
    asset.height,
    feature.item.bounds,
  );
}

export async function buildMapSvg(options: SvgMapOptions, loader: AssetLoader = loadEmbeddedSvg) {
  const plan = buildRenderPlan({
    items: options.renderedFeatures,
    camera: options.camera,
    renderScale:
      Math.max(options.width / MAP_WIDTH, options.height / MAP_HEIGHT) * options.camera.k,
    fitMode: options.fitMode,
    spriteEntries: options.spriteEntries,
    focusedPrefecture: null,
    spriteAtlasFailed: false,
    flagVisualManifest: options.flagVisualManifest,
    motifSettings: options.motifSettings,
  });
  const assetPaths = new Set<string>();
  for (const feature of plan.features) {
    if (feature.hasFlag && feature.resourcePath) assetPaths.add(feature.resourcePath);
    if (feature.visual?.kind === "separated" && feature.visual.background.kind === "asset") {
      assetPaths.add(feature.visual.background.path);
    }
  }
  const assets = await loadAssets([...assetPaths], loader);
  const assetIds = new Map([...assets.keys()].map((path, index) => [path, `flag-asset-${index}`]));
  const path = geoPath(options.projection);
  const definitions: string[] = [];
  for (const [assetPath, asset] of assets) {
    const id = assetIds.get(assetPath);
    definitions.push(
      `<symbol id="${id}" viewBox="0 0 ${number(asset.width)} ${number(asset.height)}" preserveAspectRatio="none"><image href="${asset.dataUrl}" width="${number(asset.width)}" height="${number(asset.height)}"/></symbol>`,
    );
  }

  const featureLayers: string[] = [];
  for (const [index, feature] of plan.features.entries()) {
    const pathData = path(feature.item.feature);
    if (!pathData) continue;
    const clipId = `territory-clip-${index}`;
    definitions.push(`<clipPath id="${clipId}"><path d="${pathData}"/></clipPath>`);
    const separated = options.fitMode === "motif" && feature.visual?.kind === "separated";
    const fill =
      separated &&
      feature.visual?.kind === "separated" &&
      feature.visual.background.kind === "solid"
        ? feature.visual.background.color
        : feature.hasFlag
          ? "#ffffff"
          : "#edf0f2";
    featureLayers.push(`<path d="${pathData}" fill="${fill}"/>`);
    if (
      separated &&
      feature.visual?.kind === "separated" &&
      feature.visual.background.kind === "asset"
    ) {
      const background = assets.get(feature.visual.background.path);
      const backgroundId = assetIds.get(feature.visual.background.path);
      if (background && backgroundId) {
        const placement = getFlagFitStrategy("cover").place(
          background.width,
          background.height,
          feature.item.bounds,
        );
        featureLayers.push(
          `<g clip-path="url(#${clipId})"><use href="#${backgroundId}" ${placementAttributes(placement)}/></g>`,
        );
      }
    }
    if (!feature.hasFlag || !feature.resourcePath) continue;
    const asset = assets.get(feature.resourcePath);
    const assetId = assetIds.get(feature.resourcePath);
    if (!asset || !assetId) continue;
    const placement = imagePlacement(feature, asset, options.fitMode);
    featureLayers.push(
      `<g clip-path="url(#${clipId})"><use href="#${assetId}" ${placementAttributes(placement)}/></g>`,
    );
  }

  const mainBoundaryPath = boundarySvgPath(options.renderedBoundaries, options.projection);
  const prefectureBoundaryPath = options.showPrefectureBoundaries
    ? boundarySvgPath(options.prefectureOverlayBoundaries, options.projection)
    : "";
  const boundaries = [
    mainBoundaryPath
      ? `<path d="${mainBoundaryPath}" fill="none" stroke="#aeb6bc" stroke-width="0.62" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`
      : "",
    prefectureBoundaryPath
      ? `<path d="${prefectureBoundaryPath}" fill="none" stroke="#6f7980" stroke-width="1.18" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`
      : "",
  ].join("");
  const transform = `translate(${number(options.camera.x)} ${number(options.camera.y)}) scale(${number(options.camera.k)})`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" role="img">`,
    `<title>地方旗ビューワー</title>`,
    `<defs><pattern id="map-grid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M36 0H0V36" fill="none" stroke="#dfe7ec" stroke-width="0.6"/></pattern>${definitions.join("")}</defs>`,
    `<rect width="${MAP_WIDTH}" height="${MAP_HEIGHT}" fill="#f4f8fa"/><rect width="${MAP_WIDTH}" height="${MAP_HEIGHT}" fill="url(#map-grid)"/>`,
    `<g transform="${transform}">${featureLayers.join("")}${boundaries}</g>`,
    `</svg>`,
  ].join("");
}
