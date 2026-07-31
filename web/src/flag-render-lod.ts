export type RasterBucket = 8 | 16 | 32 | 64 | 128 | 256;

export type FlagRenderLod = {
  rasterBucket: RasterBucket | null;
  useDirectSvg: boolean;
};

export const RASTER_BUCKETS = [8, 16, 32, 64, 128, 256] as const;
export const FLAG_SOURCE_OVERSAMPLE = 1.25;
export const GLOBAL_ATLAS_BUCKET = 32;
export const PREFECTURE_ATLAS_BUCKET = 64;
export const DIRECT_RASTER_MIN_BUCKET = 128;
export const DIRECT_SVG_MIN_PIXEL_SIZE = 205;

export function flagRenderLod(pixelSize: number): FlagRenderLod {
  if (pixelSize < 1.25) {
    return { rasterBucket: null, useDirectSvg: false };
  }
  const useDirectSvg = pixelSize >= DIRECT_SVG_MIN_PIXEL_SIZE;
  const rasterTarget = useDirectSvg ? 256 : pixelSize * FLAG_SOURCE_OVERSAMPLE;
  return {
    rasterBucket: RASTER_BUCKETS.find((bucket) => rasterTarget <= bucket) ?? 256,
    useDirectSvg,
  };
}
