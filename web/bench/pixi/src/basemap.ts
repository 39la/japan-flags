export type BasemapMetadata = {
  snapshotDate: string;
  generatedAt: string;
  sourceQuery: string;
  layer: "prefecture" | "municipality";
  fitMode: "cover" | "contain" | "stretch" | "motif";
  fill: number;
  width: number;
  height: number;
  bytes: number;
  svg: string;
};

export type Basemap = {
  metadata: BasemapMetadata;
  svgUrl: string;
  logicalWidth: number;
  logicalHeight: number;
};

export const BASEMAP_SVG_URL = "/maps/japan-basemap.svg";
export const BASEMAP_META_URL = "/maps/japan-basemap.json";

export async function loadBasemap(signal?: AbortSignal): Promise<Basemap> {
  const response = await fetch(BASEMAP_META_URL, { signal });
  if (!response.ok) {
    throw new Error(
      `basemap metadata is unavailable (${response.status}). ` +
        `Run: mise run bench:bake-basemap`,
    );
  }
  const metadata = (await response.json()) as BasemapMetadata;
  return {
    metadata,
    svgUrl: BASEMAP_SVG_URL,
    logicalWidth: 1000,
    logicalHeight: 760,
  };
}
