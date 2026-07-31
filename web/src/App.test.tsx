import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { PrefectureCollection, TerritoryCollection } from "./types";

const data: TerritoryCollection = {
  type: "FeatureCollection",
  metadata: {
    snapshotDate: "20260101",
    simplificationTolerance: 0.001,
    territoryCount: 1,
    matchedFlagCount: 1,
  },
  features: [
    {
      type: "Feature",
      id: 1,
      properties: {
        territoryVersionId: 1,
        jis5: "13101",
        prefectureCode: "13",
        displayName: "千代田区",
        prefectureName: "東京都",
        entityType: "special_ward",
        snapshotDate: "20260101",
        flagPageId: 1,
        flagPath: "/flags/1.svg",
        flagRole: "primary",
        assignmentKind: "direct",
        matchMethod: "jawiki_globalusage_exact",
        confidence: 1,
        commonsUrl: "https://commons.wikimedia.org/wiki/File:Example.svg",
        mapRegion: "main",
      },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [139.7, 35.6],
              [139.8, 35.6],
              [139.8, 35.7],
              [139.7, 35.7],
              [139.7, 35.6],
            ],
          ],
        ],
      },
    },
  ],
};

const prefectureData: PrefectureCollection = {
  type: "FeatureCollection",
  metadata: {
    snapshotDate: "20260101",
    simplificationTolerance: 0.01,
    prefectureCount: 1,
    matchedFlagCount: 1,
  },
  features: [
    {
      type: "Feature",
      id: "13:main",
      properties: {
        prefectureVersionId: 1,
        prefectureCode: "13",
        displayName: "東京都",
        prefectureName: "東京都",
        entityType: "prefecture",
        snapshotDate: "20260101",
        flagPageId: 2,
        flagPath: "/flags/2.svg",
        flagRole: "primary",
        assignmentKind: "direct",
        matchMethod: "wikidata_p41",
        confidence: 1,
        commonsUrl: "https://commons.wikimedia.org/wiki/File:Tokyo.svg",
        mapRegion: "main",
        mapPart: "13:main",
      },
      geometry: data.features[0].geometry,
    },
  ],
};

const profileData = {
  version: 1,
  snapshotDate: "20260101",
  prefectureCode: "13",
  profiles: {
    "13101": {
      resolutionStatus: "resolved",
      wikidataItemId: "Q1",
      wikidataUrl: "https://www.wikidata.org/wiki/Q1",
      wikipediaTitle: "千代田区",
      wikipediaUrl: "https://ja.wikipedia.org/wiki/千代田区",
      wikipediaExtract: "東京都の特別区です。",
      population: 70000,
      populationAsOf: "2024-01-01",
      populationDatePrecision: 9,
      areaKm2: 11.66,
    },
  },
};

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              String(input).includes("/profiles/")
                ? profileData
                : String(input).includes("prefectures")
                  ? prefectureData
                  : data,
            ),
        }),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("searches a municipality and opens its details", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("button", { name: "市区町村" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("heading", { name: "地方旗ビューワー" })).toBeInTheDocument();
    const search = await screen.findByLabelText("自治体を検索");
    await user.type(search, "13101");
    await user.click(await screen.findByRole("option", { name: /千代田区/ }));
    expect(screen.getByRole("complementary", { name: "自治体の詳細" })).toBeInTheDocument();
    expect(await screen.findByText("70,000人")).toBeInTheDocument();
    expect(screen.getByText("東京都の特別区です。")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByAltText("千代田区の旗")).toBeInTheDocument();
    expect(screen.getByText("標準地域コード")).toBeInTheDocument();
    expect(screen.getByText("2026-01-01")).toBeInTheDocument();
    await user.click(screen.getByLabelText("詳細を閉じる"));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "自治体の詳細" })).not.toBeInTheDocument(),
    );
  });

  it("keeps map settings inside the settings popup", async () => {
    const user = userEvent.setup();
    render(<App />);
    const settings = await screen.findByRole("button", {
      name: "地図の設定",
    });
    expect(screen.queryByRole("dialog", { name: "地図の設定" })).not.toBeInTheDocument();
    await user.click(settings);
    expect(screen.getByRole("dialog", { name: "地図の設定" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("旗の配置"), "motif");
    expect(screen.getByLabelText("旗の配置")).toHaveValue("motif");

    const autoSelectRegion = screen.getByRole("checkbox", {
      name: "地図クリックで表示地域を選択",
    });
    expect(autoSelectRegion).not.toBeChecked();
    await user.click(autoSelectRegion);
    expect(autoSelectRegion).toBeChecked();

    const prefectureBoundaries = screen.getByRole("checkbox", {
      name: "都道府県境を濃く表示",
    });
    expect(prefectureBoundaries).toBeChecked();
    await user.click(prefectureBoundaries);
    expect(prefectureBoundaries).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "都道府県" }));
    const municipalityHoverBoundaries = screen.getByRole("checkbox", {
      name: "マウスオーバー時に市区町村境を表示",
    });
    expect(municipalityHoverBoundaries).not.toBeChecked();
    await user.click(municipalityHoverBoundaries);
    expect(municipalityHoverBoundaries).toBeChecked();
  });
});
