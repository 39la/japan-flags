import { useEffect, useRef, useState } from "react";
import { SettingsIcon } from "./icons";
import type { FlagFitMode, MapDisplayOptions, MapLayer } from "./types";

type Props = {
  layer: MapLayer;
  fitMode: FlagFitMode;
  focusedPrefecture: string | null;
  displayOptions: MapDisplayOptions;
  prefectureOptions: Array<[string, string]>;
  onLayerChange: (layer: MapLayer) => void;
  onFitModeChange: (mode: FlagFitMode) => void;
  onFocusedPrefectureChange: (code: string | null) => void;
  onDisplayOptionsChange: (options: MapDisplayOptions) => void;
};

export function MapControls({
  layer,
  fitMode,
  focusedPrefecture,
  displayOptions,
  prefectureOptions,
  onLayerChange,
  onFitModeChange,
  onFocusedPrefectureChange,
  onDisplayOptionsChange,
}: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof PointerEvent && rootRef.current?.contains(event.target as Node)) {
        return;
      }
      setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [settingsOpen]);

  return (
    <div className="map-controls" ref={rootRef}>
      {settingsOpen ? (
        <div className="map-settings" role="dialog" aria-label="地図の設定">
          <label>
            <span>表示地域</span>
            <select
              value={focusedPrefecture ?? ""}
              onChange={(event) => onFocusedPrefectureChange(event.target.value || null)}
            >
              <option value="">全国</option>
              {prefectureOptions.map(([code, name]) => (
                <option value={code} key={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>旗の配置</span>
            <select
              value={fitMode}
              onChange={(event) => onFitModeChange(event.target.value as FlagFitMode)}
            >
              <option value="cover">領域を覆う</option>
              <option value="contain">旗全体を収める</option>
              <option value="stretch">領域枠へ伸縮</option>
              <option value="motif">意匠を強調</option>
            </select>
          </label>
          <label className="map-setting-toggle">
            <input
              type="checkbox"
              checked={displayOptions.autoSelectRegionOnMapClick}
              onChange={(event) =>
                onDisplayOptionsChange({
                  ...displayOptions,
                  autoSelectRegionOnMapClick: event.target.checked,
                })
              }
            />
            <span>地図クリックで表示地域を選択</span>
          </label>
          {layer === "prefecture" ? (
            <label className="map-setting-toggle">
              <input
                type="checkbox"
                checked={displayOptions.showMunicipalityBoundariesOnPrefectureHover}
                onChange={(event) =>
                  onDisplayOptionsChange({
                    ...displayOptions,
                    showMunicipalityBoundariesOnPrefectureHover: event.target.checked,
                  })
                }
              />
              <span>マウスオーバー時に市区町村境を表示</span>
            </label>
          ) : (
            <label className="map-setting-toggle">
              <input
                type="checkbox"
                checked={displayOptions.showPrefectureBoundaries}
                onChange={(event) =>
                  onDisplayOptionsChange({
                    ...displayOptions,
                    showPrefectureBoundaries: event.target.checked,
                  })
                }
              />
              <span>都道府県境を濃く表示</span>
            </label>
          )}
          {layer === "prefecture" && focusedPrefecture ? (
            <button
              className="municipality-shortcut"
              type="button"
              onClick={() => onLayerChange("municipality")}
            >
              選択県の市区町村を見る
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="layer-buttons" aria-label="地図レイヤー">
        <button
          type="button"
          aria-label="都道府県"
          aria-pressed={layer === "prefecture"}
          onClick={() => onLayerChange("prefecture")}
        >
          <strong>県</strong>
          <span>都道府県</span>
        </button>
        <button
          type="button"
          aria-label="市区町村"
          aria-pressed={layer === "municipality"}
          onClick={() => onLayerChange("municipality")}
        >
          <strong>市</strong>
          <span>市区町村</span>
        </button>
        <button
          type="button"
          className="settings-button"
          aria-label="地図の設定"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <SettingsIcon />
          <span>設定</span>
        </button>
      </div>
    </div>
  );
}
