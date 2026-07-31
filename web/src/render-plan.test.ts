import { describe, expect, it } from "vitest";
import type { RenderedFeature } from "./map-geometry";
import { buildRenderPlan } from "./render-plan";
import type { SpriteEntry } from "./flag-resources";
import type { MapFeature } from "./types";
import type { FlagVisualManifest } from "./flag-visuals";

function renderedFeature({
  jis5 = "13101",
  flagPath = "/flags/1.svg",
  bounds = [
    [10, 10],
    [110, 110],
  ],
}: {
  jis5?: string;
  flagPath?: string | null;
  bounds?: [[number, number], [number, number]];
} = {}): RenderedFeature {
  const feature: MapFeature = {
    type: "Feature",
    bbox: [139, 35, 140, 36],
    properties: {
      territoryVersionId: Number(jis5),
      jis5,
      prefectureCode: jis5.slice(0, 2),
      displayName: jis5,
      prefectureName: "テスト県",
      entityType: "municipality",
      snapshotDate: "20260101",
      flagPageId: flagPath ? 1 : null,
      flagPath,
      flagRole: flagPath ? "primary" : null,
      assignmentKind: flagPath ? "direct" : null,
      matchMethod: flagPath ? "test" : null,
      confidence: flagPath ? 1 : null,
      commonsUrl: null,
      mapRegion: "main",
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [139, 35],
          [139, 36],
          [140, 36],
          [140, 35],
          [139, 35],
        ],
      ],
    },
  };
  return {
    feature,
    canvasPath: {} as Path2D,
    bounds,
  };
}

function plan(
  items: RenderedFeature[],
  options: {
    focusedPrefecture?: string | null;
    spriteAtlasFailed?: boolean;
    fitMode?: "cover" | "contain" | "stretch" | "motif";
    spriteEntries?: Record<string, SpriteEntry>;
    flagVisualManifest?: FlagVisualManifest;
  } = {},
) {
  return buildRenderPlan({
    items,
    camera: { x: 0, y: 0, k: 1 },
    renderScale: 1,
    fitMode: options.fitMode ?? "cover",
    spriteEntries: options.spriteEntries,
    focusedPrefecture: options.focusedPrefecture ?? null,
    spriteAtlasFailed: options.spriteAtlasFailed ?? false,
    flagVisualManifest: options.flagVisualManifest,
  });
}

describe("buildRenderPlan", () => {
  it("keeps only visible features and excludes flags outside the focus", () => {
    const tokyo = renderedFeature();
    const osaka = renderedFeature({
      jis5: "27100",
      bounds: [
        [2000, 10],
        [2100, 110],
      ],
    });

    const result = plan([tokyo, osaka], { focusedPrefecture: "27" });

    expect(result.features).toHaveLength(1);
    expect(result.features[0]).toMatchObject({
      hasFlag: false,
      rasterBucket: null,
      useDirectSvg: false,
    });
    expect(result.rasterRequests).toEqual([]);
    expect(result.svgRequests).toEqual([]);
    expect(result.prefectureAtlasRequests).toEqual([]);
    expect(result.resourceSignature).toBe("||");
  });

  it("selects flag resolution from the fitted placement, not the polygon bbox", () => {
    const wide = renderedFeature({
      bounds: [
        [10, 10],
        [110, 110],
      ],
    });
    const result = plan([wide], {
      fitMode: "contain",
      spriteEntries: {
        "/flags/1.svg": { x: 0, y: 0, width: 4, height: 1 },
      },
    });

    expect(result.features[0].rasterBucket).toBe(128);
  });

  it("uses the sprite atlas for small flags and requests a raster fallback after atlas failure", () => {
    const small = renderedFeature({
      bounds: [
        [10, 10],
        [30, 30],
      ],
    });

    expect(plan([small]).rasterRequests).toEqual([]);
    expect(plan([small], { spriteAtlasFailed: true }).rasterRequests).toEqual([
      {
        key: "/flags/1.svg@32",
        path: "/flags/1.svg",
        bucket: 32,
      },
    ]);
  });

  it("requests direct SVG with a raster fallback at high zoom", () => {
    const large = renderedFeature({
      bounds: [
        [10, 10],
        [410, 410],
      ],
    });

    const result = plan([large]);

    expect(result.features[0]).toMatchObject({
      hasFlag: true,
      rasterBucket: 256,
      useDirectSvg: true,
    });
    expect(result.rasterRequests).toEqual([
      {
        key: "/flags/1.svg@256",
        path: "/flags/1.svg",
        bucket: 256,
      },
    ]);
    expect(result.svgRequests).toEqual(["/flags/1.svg"]);
    expect(result.resourceSignature).toBe("/flags/1.svg@256|/flags/1.svg|");
  });

  it("uses the separated motif resource only in motif mode", () => {
    const item = renderedFeature({
      bounds: [
        [10, 10],
        [110, 110],
      ],
    });
    item.feature.properties.visualAnchor = [0.7, 0.4];
    item.feature.properties.visualSafeRadiusRatio = 0.3;
    const manifest: FlagVisualManifest = {
      version: 1,
      visuals: {
        "/flags/1.svg": {
          kind: "separated",
          fullPath: "/flags/1.svg",
          motifPath: "/flags/motifs/1.svg",
          motifAspectRatio: 1,
          background: { kind: "solid", color: "#fff" },
          provenance: "auto",
        },
      },
    };

    const motifPlan = plan([item], {
      fitMode: "motif",
      flagVisualManifest: manifest,
    });
    const coverPlan = plan([item], {
      fitMode: "cover",
      flagVisualManifest: manifest,
    });

    expect(motifPlan.features[0].resourcePath).toBe("/flags/motifs/1.svg");
    expect(motifPlan.features[0].motifPlacement).not.toBeNull();
    expect(coverPlan.features[0].resourcePath).toBe("/flags/1.svg");
    expect(coverPlan.features[0].motifPlacement).toBeNull();
  });
});
