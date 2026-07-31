import { DEFAULT_MOTIF_PLACEMENT, type MotifPlacementOptions } from "./flag-fit";

export type FlagVisualBackground =
  | { kind: "solid"; color: string }
  | { kind: "asset"; path: string };

export type FlagVisualEntry =
  | {
      kind: "full";
      fullPath: string;
      provenance: "fallback" | "override";
      placement?: Partial<MotifPlacementOptions>;
    }
  | {
      kind: "separated";
      fullPath: string;
      motifPath: string;
      motifAspectRatio: number;
      background: FlagVisualBackground;
      provenance: "auto" | "override";
      placement?: Partial<MotifPlacementOptions>;
    };

export type FlagVisualManifest = {
  version: 1;
  visuals: Record<string, FlagVisualEntry>;
};

export type MotifRenderSettings = {
  version: 1;
  defaults: MotifPlacementOptions;
  flags: Record<
    string,
    {
      placement: Partial<MotifPlacementOptions>;
    }
  >;
};

export const DEFAULT_MOTIF_RENDER_SETTINGS: MotifRenderSettings = {
  version: 1,
  defaults: DEFAULT_MOTIF_PLACEMENT,
  flags: {},
};

export const MOTIF_SETTINGS_STORAGE_KEY = "japan-flags:motif-render:v1";

let flagVisualManifestPromise: Promise<FlagVisualManifest> | null = null;

export function loadFlagVisualManifest() {
  if (flagVisualManifestPromise) return flagVisualManifestPromise;
  flagVisualManifestPromise = fetch("/flags/flag-visuals.json")
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = (await response.json()) as FlagVisualManifest;
      if (manifest.version !== 1 || !manifest.visuals) {
        throw new Error("Invalid flag visual manifest");
      }
      return manifest;
    })
    .catch((error) => {
      flagVisualManifestPromise = null;
      throw error;
    });
  return flagVisualManifestPromise;
}

export function loadMotifRenderSettings(): MotifRenderSettings {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return DEFAULT_MOTIF_RENDER_SETTINGS;
  }
  try {
    const value = window.localStorage.getItem(MOTIF_SETTINGS_STORAGE_KEY);
    if (!value) return DEFAULT_MOTIF_RENDER_SETTINGS;
    const parsed = JSON.parse(value) as Partial<MotifRenderSettings>;
    if (parsed.version !== 1 || !parsed.defaults || !parsed.flags) {
      return DEFAULT_MOTIF_RENDER_SETTINGS;
    }
    return {
      version: 1,
      defaults: {
        ...DEFAULT_MOTIF_PLACEMENT,
        ...parsed.defaults,
      },
      flags: parsed.flags,
    };
  } catch {
    return DEFAULT_MOTIF_RENDER_SETTINGS;
  }
}

export function saveMotifRenderSettings(settings: MotifRenderSettings) {
  if (typeof window.localStorage?.setItem !== "function") return;
  window.localStorage.setItem(MOTIF_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function motifPlacementForFlag(
  settings: MotifRenderSettings,
  pageId: number | null,
  visual?: FlagVisualEntry,
): MotifPlacementOptions {
  const runtimeOverride = pageId === null ? undefined : settings.flags[String(pageId)]?.placement;
  return {
    ...DEFAULT_MOTIF_PLACEMENT,
    ...settings.defaults,
    ...visual?.placement,
    ...runtimeOverride,
  };
}

export function resolveFlagVisual(manifest: FlagVisualManifest | null, fullPath: string) {
  return (
    manifest?.visuals[fullPath] ?? {
      kind: "full",
      fullPath,
      provenance: "fallback",
    }
  );
}
