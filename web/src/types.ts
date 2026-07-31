import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";

export type MapRegion = "main" | "okinawa" | "islands";

export type TerritoryProperties = {
  layer?: "municipality";
  territoryVersionId: number;
  jis5: string;
  prefectureCode?: string;
  displayName: string;
  prefectureName: string;
  entityType: "municipality" | "designated_city" | "ward" | "special_ward" | "unassigned";
  snapshotDate: string;
  flagPageId: number | null;
  flagPath: string | null;
  flagRole: "primary" | null;
  assignmentKind: "direct" | "inherited" | null;
  matchMethod: string | null;
  confidence: number | null;
  commonsUrl: string | null;
  mapRegion: MapRegion;
  aggregationKind?: "designated_city_wards" | null;
  memberTerritoryVersionIds?: number[];
  memberJis5s?: string[];
  wardNames?: string[];
  wardCount?: number;
  visualAnchor?: [number, number] | null;
  visualCentroidAnchor?: [number, number] | null;
  visualOptimizedAnchor?: [number, number] | null;
  visualComponentBounds?: [number, number, number, number] | null;
  visualSafeRadiusRatio?: number | null;
};

export type TerritoryGeometry = Polygon | MultiPolygon;

export type MapArcSource = {
  key: string;
  arcs: ReadonlyArray<ReadonlyArray<[number, number]>>;
};

export type MapArcGeometry = {
  source: MapArcSource;
  polygons: number[][][];
};

export type TerritoryFeature = Feature<TerritoryGeometry, TerritoryProperties> & {
  arcGeometry?: MapArcGeometry;
};

export type PrefectureProperties = {
  layer?: "prefecture";
  prefectureVersionId: number;
  prefectureCode: string;
  displayName: string;
  prefectureName: string;
  entityType: "prefecture";
  snapshotDate: string;
  flagPageId: number | null;
  flagPath: string | null;
  flagRole: "primary" | null;
  assignmentKind: "direct" | null;
  matchMethod: string | null;
  confidence: number | null;
  commonsUrl: string | null;
  mapRegion: MapRegion;
  mapPart: string;
  visualAnchor?: [number, number] | null;
  visualCentroidAnchor?: [number, number] | null;
  visualOptimizedAnchor?: [number, number] | null;
  visualComponentBounds?: [number, number, number, number] | null;
  visualSafeRadiusRatio?: number | null;
};

export type PrefectureFeature = Feature<TerritoryGeometry, PrefectureProperties> & {
  arcGeometry?: MapArcGeometry;
};
export type MapFeature = TerritoryFeature | PrefectureFeature;
export type MapProperties = TerritoryProperties | PrefectureProperties;

type CoverageSimplificationMetadata = {
  algorithm: "visvalingam-whyatt-coverage";
  coordinateSpace: "web-mercator-screen-pixels";
  vwAreaTolerance: number;
  toleranceUnit: "sqrt-screen-pixel-area";
  coverageGroupCount: number;
  visvalingamGroupCount: number;
  validCoverageGroupCount: number;
  fallbackGroups: string[];
  maxAllowedAreaChangeRatio: number;
  maxAllowedShapeChangeRatio: number;
  adaptedFeatureCount: number;
  preservedOriginalFeatureCount: number;
  maxAreaChangeRatio: number;
  maxShapeChangeRatio: number;
};

type UnsimplifiedGeometryMetadata = {
  algorithm: "none";
  coordinateSpace: "geographic";
  quantizationDecimalPlaces: 5;
  repairedFeatureCount: number;
};

export type TerritoryCollection = FeatureCollection<TerritoryGeometry, TerritoryProperties> & {
  features: TerritoryFeature[];
  metadata: {
    snapshotDate: string;
    mapLayer?: MapLayer;
    simplificationTolerance: number;
    simplificationToleranceUnit?: "sqrt-screen-pixel-area";
    minPartArea?: number;
    minPartAreaUnit?: "screen-pixels-squared";
    detailLevel?: "overview" | "prefecture";
    geometryLod?: "l0" | "l1" | "l2" | "l3";
    prefectureCode?: string;
    simplification?: CoverageSimplificationMetadata | UnsimplifiedGeometryMetadata;
    territoryCount: number;
    sourceTerritoryCount?: number;
    matchedFlagCount: number;
  };
};

export type PrefectureCollection = FeatureCollection<TerritoryGeometry, PrefectureProperties> & {
  features: PrefectureFeature[];
  metadata: {
    snapshotDate: string;
    simplificationTolerance: number;
    mapLayer?: MapLayer;
    detailLevel?: "overview" | "prefecture";
    geometryLod?: "l0" | "l1" | "l2" | "l3";
    prefectureCode?: string;
    prefectureCount: number;
    matchedFlagCount: number;
  };
};

export type MapCollection = TerritoryCollection | PrefectureCollection;

export type MapLayer = "prefecture" | "municipality";
export type FlagFitMode = "cover" | "contain" | "stretch" | "motif";

export type MapDisplayOptions = {
  autoSelectRegionOnMapClick: boolean;
  showMunicipalityBoundariesOnPrefectureHover: boolean;
  showPrefectureBoundaries: boolean;
};

export type ViewTransform = {
  x: number;
  y: number;
  k: number;
};

export type MunicipalityProfile = {
  resolutionStatus: "resolved" | "unresolved";
  wikidataItemId: string | null;
  wikidataUrl: string | null;
  wikipediaTitle: string | null;
  wikipediaUrl: string | null;
  wikipediaExtract: string | null;
  population: number | null;
  populationAsOf: string | null;
  populationDatePrecision: number | null;
  areaKm2: number | null;
};

export type MunicipalityProfileChunk = {
  version: 1;
  snapshotDate: string;
  prefectureCode: string;
  profiles: Record<string, MunicipalityProfile>;
};

export type ProfileLoadState =
  | { status: "idle"; profile: null }
  | { status: "loading"; profile: null }
  | { status: "ready"; profile: MunicipalityProfile }
  | { status: "error"; profile: null };
