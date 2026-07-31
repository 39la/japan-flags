export type GeometryLod = "l0" | "l1" | "l2" | "l3";

export const GEOMETRY_MAX_ERROR = {
  l0: 0.25,
  l1: 0.0625,
  l2: 0.015625,
  l3: 0.00390625,
} as const satisfies Record<GeometryLod, number>;

export const MAX_GEOMETRY_SCREEN_ERROR = 0.35;
const LOD_ORDER: GeometryLod[] = ["l0", "l1", "l2", "l3"];
const LOD_HYSTERESIS = 0.15;

export function physicalRenderScale(viewportScale: number, cameraScale: number) {
  return Math.max(0, viewportScale) * Math.max(0, cameraScale);
}

function idealGeometryLod(renderScale: number): GeometryLod {
  const safeScale = Math.max(0, renderScale);
  return (
    LOD_ORDER.find((lod) => GEOMETRY_MAX_ERROR[lod] * safeScale <= MAX_GEOMETRY_SCREEN_ERROR) ??
    "l3"
  );
}

export function geometryLodForRenderScale(renderScale: number, current?: GeometryLod): GeometryLod {
  const ideal = idealGeometryLod(renderScale);
  if (!current || ideal === current) return ideal;

  const currentIndex = LOD_ORDER.indexOf(current);
  const idealIndex = LOD_ORDER.indexOf(ideal);
  if (idealIndex > currentIndex) {
    const upgradeAt =
      (MAX_GEOMETRY_SCREEN_ERROR / GEOMETRY_MAX_ERROR[current]) * (1 + LOD_HYSTERESIS);
    return renderScale >= upgradeAt ? ideal : current;
  }

  const coarser = LOD_ORDER[currentIndex - 1];
  if (!coarser) return current;
  const downgradeAt =
    (MAX_GEOMETRY_SCREEN_ERROR / GEOMETRY_MAX_ERROR[coarser]) * (1 - LOD_HYSTERESIS);
  return renderScale <= downgradeAt ? ideal : current;
}

export function overviewGeometryLod(lod: GeometryLod): "l0" | "l1" {
  return lod === "l0" ? "l0" : "l1";
}

export function detailGeometryLod(lod: GeometryLod): "l1" | "l2" | "l3" {
  return lod === "l0" ? "l1" : lod;
}
