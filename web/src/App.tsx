import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DetailsDrawer } from "./DetailsDrawer";
import { CreditsDialog } from "./CreditsDialog";
import { FlagDebugPanel } from "./FlagDebugPanel";
import { MapControls } from "./MapControls";
import { SearchBox } from "./SearchBox";
import { TerritoryMap } from "./TerritoryMap";
import { preloadPrefectureSpriteAtlas } from "./flag-resources";
import { cachedMunicipalityProfile, preloadMunicipalityProfiles } from "./municipality-profiles";
import { decodeMapData } from "./topology";
import { createPrefectureFeatureDeriver } from "./map-layers";
import { detailGeometryLod, overviewGeometryLod, type GeometryLod } from "./render-scale";
import { loadMotifRenderSettings, saveMotifRenderSettings } from "./flag-visuals";
import { parseMapExportRequest, scopeMapFeatures } from "./map-export";
import type {
  FlagFitMode,
  MapDisplayOptions,
  MapFeature,
  MapCollection,
  MapLayer,
  PrefectureCollection,
  ProfileLoadState,
  TerritoryCollection,
} from "./types";

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchMapData<T extends MapCollection>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  return decodeMapData(await fetchJson<unknown>(path, signal)) as T;
}

const MAX_RETAINED_DETAIL_CHUNKS = 8;
const DETAIL_CHUNK_COMMIT_WINDOW_MS = 75;
const DEFAULT_MAP_DISPLAY_OPTIONS: MapDisplayOptions = {
  autoSelectRegionOnMapClick: false,
  showMunicipalityBoundariesOnPrefectureHover: false,
  showPrefectureBoundaries: true,
};

type LoadedTerritoryCollection = {
  lod: GeometryLod;
  collection: TerritoryCollection;
};

export default function App() {
  const exportRequest = useMemo(() => parseMapExportRequest(window.location.search), []);
  const [prefectures, setPrefectures] = useState<PrefectureCollection | null>(null);
  const [municipalityOverview, setMunicipalityOverview] =
    useState<LoadedTerritoryCollection | null>(null);
  const [municipalityChunks, setMunicipalityChunks] = useState<
    Record<string, LoadedTerritoryCollection>
  >({});
  const [visibleDetailPrefectures, setVisibleDetailPrefectures] = useState<string[]>([]);
  const loadingChunks = useRef(new Set<string>());
  const pendingChunkCommits = useRef(new Map<string, LoadedTerritoryCollection>());
  const chunkCommitTimer = useRef<number | null>(null);
  const detailChunkLastUsed = useRef(new Map<string, number>());
  const activeDetailTargets = useRef(new Set<string>());
  const prefectureFeatureDeriver = useRef(createPrefectureFeatureDeriver());
  const [layer, setLayer] = useState<MapLayer>(() => exportRequest?.layer ?? "municipality");
  const [fitMode, setFitMode] = useState<FlagFitMode>(() => exportRequest?.fitMode ?? "cover");
  const [displayOptions, setDisplayOptions] = useState<MapDisplayOptions>(
    DEFAULT_MAP_DISPLAY_OPTIONS,
  );
  const [motifSettings, setMotifSettings] = useState(loadMotifRenderSettings);
  const flagDebugEnabled = useMemo(
    () => new URLSearchParams(window.location.search).get("flagDebug") === "1",
    [],
  );
  const [focusedPrefecture, setFocusedPrefecture] = useState<string | null>(null);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MapFeature | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [profileLoadState, setProfileLoadState] = useState<ProfileLoadState>({
    status: "idle",
    profile: null,
  });
  const [profileRetry, setProfileRetry] = useState(0);
  const [geometryLod, setGeometryLod] = useState<GeometryLod>("l0");
  const overviewLod = overviewGeometryLod(geometryLod);
  const detailLod = detailGeometryLod(geometryLod);
  const detailLodRef = useRef(detailLod);
  detailLodRef.current = detailLod;

  const flushPendingChunks = useCallback(() => {
    chunkCommitTimer.current = null;
    if (!pendingChunkCommits.current.size) return;
    const additions = Object.fromEntries(pendingChunkCommits.current);
    pendingChunkCommits.current.clear();
    startTransition(() => {
      setMunicipalityChunks((current) =>
        Object.fromEntries(
          Object.entries({ ...current, ...additions })
            .sort(([left], [right]) => {
              const leftProtected = activeDetailTargets.current.has(left);
              const rightProtected = activeDetailTargets.current.has(right);
              if (leftProtected !== rightProtected) return leftProtected ? -1 : 1;
              return (
                (detailChunkLastUsed.current.get(right) ?? 0) -
                (detailChunkLastUsed.current.get(left) ?? 0)
              );
            })
            .filter(
              ([chunkCode], index) =>
                index < MAX_RETAINED_DETAIL_CHUNKS || activeDetailTargets.current.has(chunkCode),
            ),
        ),
      );
    });
  }, []);

  const scheduleChunkCommit = useCallback(() => {
    if (chunkCommitTimer.current !== null) return;
    chunkCommitTimer.current = window.setTimeout(flushPendingChunks, DETAIL_CHUNK_COMMIT_WINDOW_MS);
  }, [flushPendingChunks]);

  useEffect(
    () => () => {
      if (chunkCommitTimer.current !== null) window.clearTimeout(chunkCommitTimer.current);
    },
    [],
  );

  useEffect(() => {
    saveMotifRenderSettings(motifSettings);
  }, [motifSettings]);

  useEffect(() => {
    const controller = new AbortController();
    fetchMapData<PrefectureCollection>("/data/prefectures.topojson", controller.signal)
      .then(setPrefectures)
      .catch((reason: unknown) => {
        if ((reason as Error).name !== "AbortError") {
          setError("都道府県地図を読み込めませんでした");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (municipalityOverview?.lod === overviewLod) {
      return;
    }
    const controller = new AbortController();
    fetchMapData<TerritoryCollection>(
      `/data/territories-overview-${overviewLod}.topojson`,
      controller.signal,
    )
      .then((collection) => setMunicipalityOverview({ lod: overviewLod, collection }))
      .catch((reason: unknown) => {
        if ((reason as Error).name !== "AbortError") {
          setError("市区町村地図を読み込めませんでした");
        }
      });
    return () => controller.abort();
  }, [municipalityOverview?.lod, overviewLod]);

  useEffect(() => {
    if (!municipalityOverview) return;
    const targets = new Set(visibleDetailPrefectures);
    if (exportRequest?.layer === "municipality") {
      for (const code of exportRequest.codes) targets.add(code);
    }
    if (layer === "municipality" && focusedPrefecture) {
      targets.add(focusedPrefecture);
    }
    activeDetailTargets.current = targets;
    const now = performance.now();
    for (const code of targets) detailChunkLastUsed.current.set(code, now);
    for (const code of targets) {
      void preloadPrefectureSpriteAtlas(code);
      void preloadMunicipalityProfiles(code).catch(() => undefined);
      const loadKey = `${code}:${detailLod}`;
      if (
        municipalityChunks[code]?.lod === detailLod ||
        pendingChunkCommits.current.get(code)?.lod === detailLod ||
        loadingChunks.current.has(loadKey)
      ) {
        continue;
      }
      loadingChunks.current.add(loadKey);
      fetchMapData<TerritoryCollection>(`/data/territories/${code}-${detailLod}.topojson`)
        .then((chunk) => {
          if (detailLodRef.current !== detailLod) return;
          detailChunkLastUsed.current.set(code, performance.now());
          pendingChunkCommits.current.set(code, { lod: detailLod, collection: chunk });
          scheduleChunkCommit();
        })
        .catch(() => {
          setError(`${code}の詳細地図を読み込めませんでした`);
        })
        .finally(() => {
          loadingChunks.current.delete(loadKey);
        });
    }
  }, [
    focusedPrefecture,
    detailLod,
    exportRequest,
    layer,
    municipalityChunks,
    municipalityOverview,
    scheduleChunkCommit,
    visibleDetailPrefectures,
  ]);

  useEffect(() => {
    if (!selected || selected.properties.entityType === "prefecture") {
      setProfileLoadState({ status: "idle", profile: null });
      return;
    }
    const code = selected.properties.prefectureCode ?? selected.properties.jis5.slice(0, 2);
    const jis5 = selected.properties.jis5;
    const cached = cachedMunicipalityProfile(code, jis5);
    if (cached) {
      setProfileLoadState({ status: "ready", profile: cached });
      return;
    }
    let active = true;
    setProfileLoadState({ status: "loading", profile: null });
    preloadMunicipalityProfiles(code)
      .then((chunk) => {
        if (!active) return;
        setProfileLoadState({
          status: "ready",
          profile: chunk.profiles[jis5] ?? {
            resolutionStatus: "unresolved",
            wikidataItemId: null,
            wikidataUrl: null,
            wikipediaTitle: null,
            wikipediaUrl: null,
            wikipediaExtract: null,
            population: null,
            populationAsOf: null,
            populationDatePrecision: null,
            areaKm2: null,
          },
        });
      })
      .catch(() => {
        if (active) {
          setProfileLoadState({ status: "error", profile: null });
        }
      });
    return () => {
      active = false;
    };
  }, [profileRetry, selected]);

  const territoryFeatures = useMemo(() => {
    if (!municipalityOverview) return [];
    const activeChunks = Object.entries(municipalityChunks).filter(
      ([, chunk]) => chunk.lod === detailLod,
    );
    const detailedCodes = new Set(activeChunks.map(([code]) => code));
    return [
      ...municipalityOverview.collection.features.filter(
        (feature) =>
          !detailedCodes.has(
            feature.properties.prefectureCode ?? feature.properties.jis5.slice(0, 2),
          ),
      ),
      ...activeChunks.flatMap(([, { collection }]) => collection.features),
    ];
  }, [detailLod, municipalityChunks, municipalityOverview]);
  const prefectureFeatures = useMemo(
    () => prefectureFeatureDeriver.current(prefectures?.features ?? [], territoryFeatures),
    [prefectures, territoryFeatures],
  );
  const scopedTerritoryFeatures = useMemo(
    () => scopeMapFeatures(territoryFeatures, exportRequest),
    [exportRequest, territoryFeatures],
  );
  const scopedPrefectureFeatures = useMemo(
    () => scopeMapFeatures(prefectureFeatures, exportRequest),
    [exportRequest, prefectureFeatures],
  );
  const features = useMemo<MapFeature[]>(
    () => (layer === "prefecture" ? scopedPrefectureFeatures : scopedTerritoryFeatures),
    [layer, scopedPrefectureFeatures, scopedTerritoryFeatures],
  );
  const prefectureOptions = useMemo(() => {
    const byCode = new Map<string, string>();
    for (const feature of prefectures?.features ?? []) {
      byCode.set(feature.properties.prefectureCode, feature.properties.displayName);
    }
    return [...byCode].sort(([left], [right]) => left.localeCompare(right));
  }, [prefectures]);
  const loading = !prefectures || !municipalityOverview;
  const exportDataReady =
    !exportRequest ||
    (!loading &&
      !error &&
      municipalityOverview?.lod === overviewLod &&
      (exportRequest.layer !== "municipality" ||
        exportRequest.codes.every((code) => municipalityChunks[code]?.lod === detailLod)));

  const selectRegionForFeature = (feature: MapFeature) => {
    setFocusedPrefecture(
      feature.properties.entityType === "prefecture"
        ? feature.properties.prefectureCode
        : (feature.properties.prefectureCode ?? feature.properties.jis5.slice(0, 2)),
    );
  };

  const selectMapFeature = (feature: MapFeature) => {
    setSelected(feature);
    if (displayOptions.autoSelectRegionOnMapClick) {
      selectRegionForFeature(feature);
    }
  };

  const selectSearchResult = (feature: MapFeature) => {
    setSelected(feature);
    selectRegionForFeature(feature);
    setFocusRequest((request) => request + 1);
  };

  const switchLayer = (nextLayer: MapLayer) => {
    setLayer(nextLayer);
    setSelected(null);
  };

  return (
    <main
      className={`app${selected ? " has-selection" : ""}${exportRequest ? " is-map-export" : ""}`}
    >
      <header className="app-header">
        <h1>地方旗ビューワー</h1>
        {!!features.length && (
          <SearchBox features={features} layer={layer} onSelect={selectSearchResult} />
        )}
        <button
          className="credits-trigger"
          type="button"
          aria-haspopup="dialog"
          onClick={() => setCreditsOpen(true)}
        >
          出典・ライセンス
        </button>
      </header>
      <section className="atlas">
        {loading && !error && (
          <p className="status">
            {layer === "prefecture"
              ? "都道府県地図を読み込んでいます…"
              : "市区町村地図を読み込んでいます…"}
          </p>
        )}
        {error && <p className="status is-error">{error}</p>}
        {!!features.length && (
          <TerritoryMap
            features={features}
            municipalityBoundaryFeatures={scopedTerritoryFeatures}
            prefectureBoundaryFeatures={scopedPrefectureFeatures}
            layer={layer}
            selected={selected}
            focusRequest={focusRequest}
            focusedPrefecture={focusedPrefecture}
            fitMode={fitMode}
            motifSettings={motifSettings}
            displayOptions={displayOptions}
            exportRequest={exportRequest}
            exportDataReady={exportDataReady}
            geometryLod={geometryLod}
            onSelect={selectMapFeature}
            onVisiblePrefecturesChange={setVisibleDetailPrefectures}
            onGeometryLodChange={setGeometryLod}
          />
        )}
        <MapControls
          layer={layer}
          fitMode={fitMode}
          focusedPrefecture={focusedPrefecture}
          displayOptions={displayOptions}
          prefectureOptions={prefectureOptions}
          onLayerChange={switchLayer}
          onFitModeChange={setFitMode}
          onFocusedPrefectureChange={(code) => {
            setFocusedPrefecture(code);
            setSelected(null);
          }}
          onDisplayOptionsChange={setDisplayOptions}
        />
        {flagDebugEnabled && (
          <FlagDebugPanel
            selectedPageId={selected?.properties.flagPageId ?? null}
            settings={motifSettings}
            onChange={setMotifSettings}
          />
        )}
        {selected && (
          <DetailsDrawer
            feature={selected}
            profileState={profileLoadState}
            onRetryProfile={() => setProfileRetry((value) => value + 1)}
            onClose={() => setSelected(null)}
          />
        )}
      </section>
      {creditsOpen ? (
        <CreditsDialog
          snapshotDate={features[0]?.properties.snapshotDate ?? "20260101"}
          onClose={() => setCreditsOpen(false)}
        />
      ) : null}
    </main>
  );
}
