import type { MunicipalityProfile, MunicipalityProfileChunk } from "./types";

const chunks = new Map<string, MunicipalityProfileChunk>();
const pending = new Map<string, Promise<MunicipalityProfileChunk>>();

export function cachedMunicipalityProfile(
  prefectureCode: string,
  jis5: string,
): MunicipalityProfile | null {
  return chunks.get(prefectureCode)?.profiles[jis5] ?? null;
}

export function preloadMunicipalityProfiles(prefectureCode: string) {
  const cached = chunks.get(prefectureCode);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(prefectureCode);
  if (existing) return existing;
  const request = fetch(`/data/profiles/${prefectureCode}.json`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const chunk = (await response.json()) as MunicipalityProfileChunk;
      if (chunk.version !== 1 || chunk.prefectureCode !== prefectureCode || !chunk.profiles) {
        throw new Error("Invalid municipality profile chunk");
      }
      chunks.set(prefectureCode, chunk);
      return chunk;
    })
    .finally(() => {
      pending.delete(prefectureCode);
    });
  pending.set(prefectureCode, request);
  return request;
}

export function clearMunicipalityProfileCacheForTests() {
  chunks.clear();
  pending.clear();
}
