import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cachedMunicipalityProfile,
  clearMunicipalityProfileCacheForTests,
  preloadMunicipalityProfiles,
} from "./municipality-profiles";

describe("municipality profile chunks", () => {
  afterEach(() => {
    clearMunicipalityProfileCacheForTests();
    vi.unstubAllGlobals();
  });

  it("deduplicates concurrent requests and exposes cached profiles", async () => {
    const response = {
      version: 1,
      snapshotDate: "20260101",
      prefectureCode: "13",
      profiles: {
        "13101": {
          resolutionStatus: "resolved",
          wikidataItemId: "Q1",
          wikidataUrl: "https://www.wikidata.org/wiki/Q1",
          wikipediaTitle: "テスト区",
          wikipediaUrl: "https://ja.wikipedia.org/wiki/テスト区",
          wikipediaExtract: "概要",
          population: 100,
          populationAsOf: "2024-01-01",
          populationDatePrecision: 9,
          areaKm2: 10,
        },
      },
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => response,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      preloadMunicipalityProfiles("13"),
      preloadMunicipalityProfiles("13"),
    ]);

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cachedMunicipalityProfile("13", "13101")?.population).toBe(100);
  });
});
