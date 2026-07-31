import { geoMercator } from "d3-geo";
import { describe, expect, it } from "vitest";
import { DEFAULT_MOTIF_RENDER_SETTINGS } from "./flag-visuals";
import { buildMapSvg } from "./svg-renderer";
import type { PrefectureFeature } from "./types";

const mapFeature: PrefectureFeature = {
  type: "Feature",
  id: "13:main",
  bbox: [139, 35, 140, 36],
  properties: {
    prefectureVersionId: 13,
    prefectureCode: "13",
    displayName: "東京都",
    prefectureName: "東京都",
    entityType: "prefecture",
    snapshotDate: "20260101",
    flagPageId: 1,
    flagPath: "/flags/tokyo.svg",
    flagRole: "primary",
    assignmentKind: "direct",
    matchMethod: "fixture",
    confidence: 1,
    commonsUrl: null,
    mapRegion: "main",
    mapPart: "13:main",
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

describe("buildMapSvg", () => {
  it("emits clipped vector geometry and embeds a flag asset once", async () => {
    const projection = geoMercator().fitExtent(
      [
        [20, 20],
        [980, 740],
      ],
      mapFeature,
    );
    const svg = await buildMapSvg(
      {
        width: 1600,
        height: 1200,
        layer: "prefecture",
        fitMode: "cover",
        camera: { x: 0, y: 0, k: 1 },
        projection,
        renderedFeatures: [
          {
            feature: mapFeature,
            canvasPath: {} as Path2D,
            bounds: [
              [20, 20],
              [980, 740],
            ],
          },
        ],
        renderedBoundaries: [],
        prefectureOverlayBoundaries: [],
        showPrefectureBoundaries: false,
        flagVisualManifest: null,
        motifSettings: DEFAULT_MOTIF_RENDER_SETTINGS,
      },
      async () => ({
        dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        width: 3,
        height: 2,
      }),
    );
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"');
    expect(svg).toContain('<clipPath id="territory-clip-0">');
    expect(svg).toContain('<symbol id="flag-asset-0"');
    expect(svg).toContain('<use href="#flag-asset-0"');
    expect(svg.match(/data:image\/svg\+xml;base64/g)).toHaveLength(1);
  });
});
