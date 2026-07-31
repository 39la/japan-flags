import { RASTER_BUCKETS, type RasterBucket } from "./flag-render-lod";

type CachedRaster = {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  bytes: number;
  lastUsed: number;
};

export type RasterRequest = {
  key: string;
  path: string;
  bucket: RasterBucket;
};

type CachedSvg = {
  image: HTMLImageElement;
  width: number;
  height: number;
  lastUsed: number;
};

export type SpriteEntry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SpriteManifest = {
  image: string;
  sprites: Record<string, SpriteEntry>;
};

export type SpriteAtlas = {
  image: HTMLImageElement;
  sprites: Record<string, SpriteEntry>;
};

const rasterCache = new Map<string, CachedRaster>();
const rasterQueue: RasterRequest[] = [];
const pendingRasters = new Map<string, PendingResource>();
const failedRasters = new Set<string>();
const allowedRasters = new Set<string>();
const prefetchedRasters = new Set<string>();
const svgCache = new Map<string, CachedSvg>();
const svgQueue: string[] = [];
const pendingSvgs = new Map<string, PendingResource>();
const failedSvgs = new Set<string>();
const allowedSvgs = new Set<string>();
const prefetchedSvgs = new Set<string>();
let activeRasterLoads = 0;
let activeSvgLoads = 0;
let rasterCacheBytes = 0;
let prefectureAtlasCacheBytes = 0;
let spriteAtlasPromise: Promise<SpriteAtlas> | null = null;
const prefectureAtlasCache = new Map<
  string,
  {
    atlas: SpriteAtlas;
    bytes: number;
    lastUsed: number;
  }
>();
const prefectureAtlasPromises = new Map<string, Promise<SpriteAtlas | null>>();
const failedPrefectureAtlases = new Set<string>();
const allowedPrefectureAtlases = new Set<string>();

type PendingResource = {
  promise: Promise<boolean>;
  resolve: (loaded: boolean) => void;
};

const MAX_RASTER_LOADS = 4;
const MAX_RASTER_BYTES = 48 * 1024 * 1024;
const MAX_SVG_LOADS = 4;
const MAX_SVG_CACHE_ENTRIES = 24;
const MAX_PREFECTURE_ATLAS_BYTES = 16 * 1024 * 1024;

export function rasterKey(path: string, bucket: RasterBucket) {
  return `${path}@${bucket}`;
}

function createPendingResource() {
  let resolve: (loaded: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function settlePendingResource(
  pending: Map<string, PendingResource>,
  key: string,
  loaded: boolean,
) {
  const resource = pending.get(key);
  if (!resource) return;
  pending.delete(key);
  resource.resolve(loaded);
}

function evictSvgCache() {
  if (svgCache.size <= MAX_SVG_CACHE_ENTRIES) return;
  const removable = [...svgCache]
    .filter(([path]) => !allowedSvgs.has(path) && !prefetchedSvgs.has(path))
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
  for (const [path, cached] of removable) {
    if (svgCache.size <= MAX_SVG_CACHE_ENTRIES) break;
    cached.image.src = "";
    svgCache.delete(path);
  }
}

function pumpSvgQueue() {
  while (activeSvgLoads < MAX_SVG_LOADS && svgQueue.length) {
    const path = svgQueue.shift();
    if (!path) break;
    if ((!allowedSvgs.has(path) && !prefetchedSvgs.has(path)) || svgCache.has(path)) {
      settlePendingResource(pendingSvgs, path, svgCache.has(path));
      continue;
    }

    activeSvgLoads += 1;
    const image = new Image();
    image.decoding = "async";
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      image.onload = null;
      image.onerror = null;
      activeSvgLoads -= 1;
      settlePendingResource(pendingSvgs, path, svgCache.has(path));
      window.setTimeout(pumpSvgQueue, 0);
    };
    image.onload = () => {
      if (allowedSvgs.has(path) || prefetchedSvgs.has(path)) {
        svgCache.set(path, {
          image,
          width: Math.max(1, image.naturalWidth),
          height: Math.max(1, image.naturalHeight),
          lastUsed: performance.now(),
        });
        evictSvgCache();
      } else {
        prefetchedSvgs.delete(path);
        finish();
        image.src = "";
        return;
      }
      prefetchedSvgs.delete(path);
      finish();
    };
    image.onerror = () => {
      failedSvgs.add(path);
      prefetchedSvgs.delete(path);
      finish();
      image.src = "";
    };
    image.src = path;
  }
}

function queueFlagSvg(path: string) {
  const existing = pendingSvgs.get(path);
  if (existing) return existing.promise;
  const pending = createPendingResource();
  pendingSvgs.set(path, pending);
  svgQueue.push(path);
  return pending.promise;
}

function requestFlagSvgs(paths: string[], activate: boolean) {
  const wanted = activate ? allowedSvgs : prefetchedSvgs;
  wanted.clear();
  for (const path of paths) wanted.add(path);
  const pending: Promise<boolean>[] = [];
  for (const path of paths) {
    if (svgCache.has(path) || failedSvgs.has(path)) continue;
    pending.push(queueFlagSvg(path));
  }
  evictSvgCache();
  pumpSvgQueue();
  if (!pending.length) return null;
  return Promise.all(pending).then((loaded) => loaded.some(Boolean));
}

export function cachedFlagSvg(path: string) {
  const cached = svgCache.get(path);
  if (!cached) return null;
  cached.lastUsed = performance.now();
  return cached;
}

async function fetchSpriteAtlas(manifestPath: string) {
  return fetch(manifestPath).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = (await response.json()) as SpriteManifest;
    if (!manifest.image || !manifest.sprites) {
      throw new Error("Invalid flag sprite manifest");
    }
    const image = new Image();
    image.decoding = "async";
    image.src = manifest.image;
    await image.decode();
    return { image, sprites: manifest.sprites };
  });
}

export function loadSpriteAtlas() {
  if (spriteAtlasPromise) return spriteAtlasPromise;
  spriteAtlasPromise = fetchSpriteAtlas("/flags/sprites-global-32.json").catch((error) => {
    spriteAtlasPromise = null;
    throw error;
  });
  return spriteAtlasPromise;
}

function evictPrefectureAtlasCache() {
  if (prefectureAtlasCacheBytes <= MAX_PREFECTURE_ATLAS_BYTES) return;
  const removable = [...prefectureAtlasCache]
    .filter(([code]) => !allowedPrefectureAtlases.has(code))
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
  for (const [code, cached] of removable) {
    if (prefectureAtlasCacheBytes <= MAX_PREFECTURE_ATLAS_BYTES) break;
    cached.atlas.image.src = "";
    prefectureAtlasCache.delete(code);
    prefectureAtlasCacheBytes -= cached.bytes;
  }
}

function loadPrefectureSpriteAtlas(code: string) {
  const cached = prefectureAtlasCache.get(code);
  if (cached) {
    cached.lastUsed = performance.now();
    return Promise.resolve(cached.atlas);
  }
  if (failedPrefectureAtlases.has(code)) return Promise.resolve(null);
  const pending = prefectureAtlasPromises.get(code);
  if (pending) return pending;
  const promise = fetchSpriteAtlas(`/flags/sprites/${code}-64.json`)
    .then((atlas) => {
      const cached = {
        atlas,
        bytes: atlas.image.naturalWidth * atlas.image.naturalHeight * 4,
        lastUsed: performance.now(),
      };
      const previous = prefectureAtlasCache.get(code);
      if (previous) prefectureAtlasCacheBytes -= previous.bytes;
      prefectureAtlasCache.set(code, cached);
      prefectureAtlasCacheBytes += cached.bytes;
      evictPrefectureAtlasCache();
      return atlas;
    })
    .catch(() => {
      failedPrefectureAtlases.add(code);
      return null;
    })
    .finally(() => {
      prefectureAtlasPromises.delete(code);
    });
  prefectureAtlasPromises.set(code, promise);
  return promise;
}

export function preloadPrefectureSpriteAtlas(code: string) {
  return loadPrefectureSpriteAtlas(code);
}

export function requestPrefectureSpriteAtlases(codes: string[]) {
  allowedPrefectureAtlases.clear();
  for (const code of codes) allowedPrefectureAtlases.add(code);
  evictPrefectureAtlasCache();
  const pending = codes
    .filter((code) => !prefectureAtlasCache.has(code) && !failedPrefectureAtlases.has(code))
    .map(loadPrefectureSpriteAtlas);
  if (!pending.length) return null;
  return Promise.all(pending).then((atlases) => atlases.some((atlas) => atlas !== null));
}

export function cachedPrefectureSpriteAtlas(code: string) {
  const cached = prefectureAtlasCache.get(code);
  if (!cached) return null;
  cached.lastUsed = performance.now();
  return cached.atlas;
}

function evictRasterCache() {
  if (rasterCacheBytes <= MAX_RASTER_BYTES) return;
  const removable = [...rasterCache]
    .filter(([key]) => !allowedRasters.has(key) && !prefetchedRasters.has(key))
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
  for (const [key, raster] of removable) {
    if (rasterCacheBytes <= MAX_RASTER_BYTES) break;
    raster.bitmap.close();
    rasterCache.delete(key);
    rasterCacheBytes -= raster.bytes;
  }
}

function pumpRasterQueue() {
  while (activeRasterLoads < MAX_RASTER_LOADS && rasterQueue.length) {
    const request = rasterQueue.shift();
    if (!request) break;
    if (
      (!allowedRasters.has(request.key) && !prefetchedRasters.has(request.key)) ||
      rasterCache.has(request.key)
    ) {
      settlePendingResource(pendingRasters, request.key, rasterCache.has(request.key));
      continue;
    }

    activeRasterLoads += 1;
    const image = new Image();
    image.decoding = "async";
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      image.onload = null;
      image.onerror = null;
      activeRasterLoads -= 1;
      image.src = "";
      settlePendingResource(pendingRasters, request.key, rasterCache.has(request.key));
      window.setTimeout(pumpRasterQueue, 0);
    };
    image.onload = async () => {
      try {
        const scale = request.bucket / Math.max(1, image.naturalWidth, image.naturalHeight);
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context is unavailable");
        context.drawImage(image, 0, 0, width, height);
        const bitmap = await createImageBitmap(canvas);
        if (allowedRasters.has(request.key) || prefetchedRasters.has(request.key)) {
          const cached = {
            bitmap,
            width,
            height,
            bytes: width * height * 4,
            lastUsed: performance.now(),
          };
          const previous = rasterCache.get(request.key);
          if (previous) {
            previous.bitmap.close();
            rasterCacheBytes -= previous.bytes;
          }
          rasterCache.set(request.key, cached);
          rasterCacheBytes += cached.bytes;
          evictRasterCache();
        } else {
          bitmap.close();
        }
      } catch {
        failedRasters.add(request.key);
        // A broken source stays unpainted; polygon hit-testing still works.
      } finally {
        prefetchedRasters.delete(request.key);
        finish();
      }
    };
    image.onerror = () => {
      failedRasters.add(request.key);
      prefetchedRasters.delete(request.key);
      finish();
    };
    image.src = request.path;
  }
}

function queueFlagRaster(request: RasterRequest) {
  const existing = pendingRasters.get(request.key);
  if (existing) return existing.promise;
  const pending = createPendingResource();
  pendingRasters.set(request.key, pending);
  rasterQueue.push(request);
  return pending.promise;
}

function requestFlagRasters(requests: RasterRequest[], activate: boolean) {
  const wanted = activate ? allowedRasters : prefetchedRasters;
  wanted.clear();
  for (const request of requests) wanted.add(request.key);
  const pending: Promise<boolean>[] = [];
  for (const request of requests) {
    if (rasterCache.has(request.key) || failedRasters.has(request.key)) continue;
    pending.push(queueFlagRaster(request));
  }
  evictRasterCache();
  pumpRasterQueue();
  if (!pending.length) return null;
  return Promise.all(pending).then((loaded) => loaded.some(Boolean));
}

export function requestFlagResources(rasterRequests: RasterRequest[], svgPaths: string[]) {
  return loadFlagResources(rasterRequests, svgPaths, true);
}

export function prefetchFlagResources(rasterRequests: RasterRequest[], svgPaths: string[]) {
  return loadFlagResources(rasterRequests, svgPaths, false);
}

function loadFlagResources(rasterRequests: RasterRequest[], svgPaths: string[], activate: boolean) {
  const batches = [
    requestFlagRasters(rasterRequests, activate),
    requestFlagSvgs(svgPaths, activate),
  ].filter((batch): batch is Promise<boolean> => batch !== null);
  if (!batches.length) return null;
  return Promise.all(batches).then((loaded) => loaded.some(Boolean));
}

export function cachedFlagRaster(path: string, bucket: RasterBucket) {
  const preferredBuckets = [
    ...RASTER_BUCKETS.filter((candidate) => candidate <= bucket).reverse(),
    ...RASTER_BUCKETS.filter((candidate) => candidate > bucket),
  ];
  for (const candidate of preferredBuckets) {
    const cached = rasterCache.get(rasterKey(path, candidate));
    if (!cached) continue;
    cached.lastUsed = performance.now();
    return cached;
  }
  return null;
}
