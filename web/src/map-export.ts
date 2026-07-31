import { focusBounds } from "./map-model";
import { prefectureCode } from "./render-plan";
import type { FlagFitMode, MapFeature, MapLayer, ViewTransform } from "./types";
import type { RenderedFeature } from "./map-geometry";

export type MapExportRequest = {
  layer: MapLayer;
  fitMode: FlagFitMode;
  codes: string[];
  fill: number;
};

const FIT_MODES = new Set<FlagFitMode>(["cover", "contain", "stretch", "motif"]);

export function parseMapExportRequest(search: string): MapExportRequest | null {
  const parameters = new URLSearchParams(search);
  if (parameters.get("mapExport") !== "1") return null;
  const layer = parameters.get("layer") === "municipality" ? "municipality" : "prefecture";
  const requestedFitMode = parameters.get("fitMode") as FlagFitMode | null;
  const fitMode = requestedFitMode && FIT_MODES.has(requestedFitMode) ? requestedFitMode : "cover";
  const codes = [...new Set((parameters.get("codes") ?? "").split(","))]
    .map((code) => code.trim())
    .filter((code) => /^\d{2}$/.test(code))
    .sort();
  const requestedFill = Number(parameters.get("fill") ?? "0.86");
  return {
    layer,
    fitMode,
    codes,
    fill: Number.isFinite(requestedFill) ? Math.min(0.96, Math.max(0.35, requestedFill)) : 0.86,
  };
}

export function exportCamera(
  renderedFeatures: RenderedFeature[],
  request: MapExportRequest,
  nationalCamera: ViewTransform,
) {
  if (!request.codes.length) return { ...nationalCamera };
  const codeSet = new Set(request.codes);
  const targets = renderedFeatures.filter((item) => codeSet.has(prefectureCode(item.feature)));
  if (!targets.length) return null;
  const bounds = targets.reduce<[[number, number], [number, number]]>(
    (current, item) => [
      [Math.min(current[0][0], item.bounds[0][0]), Math.min(current[0][1], item.bounds[0][1])],
      [Math.max(current[1][0], item.bounds[1][0]), Math.max(current[1][1], item.bounds[1][1])],
    ],
    [
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    ],
  );
  return focusBounds(bounds, 24, request.fill);
}

export function scopeMapFeatures(features: MapFeature[], request: MapExportRequest | null) {
  if (!request?.codes.length) return features;
  const codeSet = new Set(request.codes);
  return features.filter((feature) => codeSet.has(prefectureCode(feature)));
}
