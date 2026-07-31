import { useState } from "react";
import { DEFAULT_MOTIF_RENDER_SETTINGS, type MotifRenderSettings } from "./flag-visuals";
import type { MotifPlacementOptions } from "./flag-fit";

type NumericPlacementKey = Exclude<keyof MotifPlacementOptions, "anchorMode">;

type Props = {
  selectedPageId: number | null;
  settings: MotifRenderSettings;
  onChange: (settings: MotifRenderSettings) => void;
};

const controls: Array<{
  key: NumericPlacementKey;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: "anchorBias", label: "ハイブリッドの内接円寄せ", min: 0, max: 1, step: 0.01 },
  { key: "motifScale", label: "意匠スケール", min: 0.2, max: 1.8, step: 0.01 },
  { key: "overflow", label: "許容はみ出し", min: 0, max: 1.5, step: 0.01 },
  { key: "edgePadding", label: "縁の余白", min: 0, max: 0.45, step: 0.01 },
  { key: "minSizeRatio", label: "最小サイズ", min: 0, max: 0.8, step: 0.01 },
  { key: "maxSizeRatio", label: "最大サイズ", min: 0.1, max: 1.5, step: 0.01 },
  { key: "anchorOffsetX", label: "横位置", min: -0.5, max: 0.5, step: 0.01 },
  { key: "anchorOffsetY", label: "縦位置", min: -0.5, max: 0.5, step: 0.01 },
];

export function FlagDebugPanel({ selectedPageId, settings, onChange }: Props) {
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const selectedKey = selectedOnly && selectedPageId !== null ? String(selectedPageId) : null;
  const values = selectedKey
    ? {
        ...settings.defaults,
        ...settings.flags[selectedKey]?.placement,
      }
    : settings.defaults;

  const update = (key: NumericPlacementKey, value: number) => {
    if (!selectedKey) {
      onChange({
        ...settings,
        defaults: { ...settings.defaults, [key]: value },
      });
      return;
    }
    onChange({
      ...settings,
      flags: {
        ...settings.flags,
        [selectedKey]: {
          placement: {
            ...settings.flags[selectedKey]?.placement,
            [key]: value,
          },
        },
      },
    });
  };

  return (
    <aside className="flag-debug-panel" aria-label="旗意匠の調整">
      <h2>意匠配置デバッグ</h2>
      <label className="flag-debug-scope">
        <input
          type="checkbox"
          checked={selectedOnly}
          disabled={selectedPageId === null}
          onChange={(event) => setSelectedOnly(event.target.checked)}
        />
        選択中の旗だけ
      </label>
      <label>
        <span>基準点</span>
        <select
          value={values.anchorMode}
          onChange={(event) => {
            const anchorMode = event.target.value as MotifPlacementOptions["anchorMode"];
            if (!selectedKey) {
              onChange({
                ...settings,
                defaults: { ...settings.defaults, anchorMode },
              });
              return;
            }
            onChange({
              ...settings,
              flags: {
                ...settings.flags,
                [selectedKey]: {
                  placement: {
                    ...settings.flags[selectedKey]?.placement,
                    anchorMode,
                  },
                },
              },
            });
          }}
        >
          <option value="incenter">最大内接円</option>
          <option value="centroid">面積重心</option>
          <option value="hybrid">重心＋内接円</option>
          <option value="optimized">自動バランス</option>
        </select>
      </label>
      {controls.map((control) => (
        <label key={control.key}>
          <span>
            {control.label}
            <output>{values[control.key].toFixed(2)}</output>
          </span>
          <input
            type="range"
            min={control.min}
            max={control.max}
            step={control.step}
            value={values[control.key]}
            onChange={(event) => update(control.key, Number(event.target.value))}
          />
        </label>
      ))}
      <div className="flag-debug-actions">
        <button type="button" onClick={() => onChange(DEFAULT_MOTIF_RENDER_SETTINGS)}>
          リセット
        </button>
        <button
          type="button"
          onClick={() => {
            const clipboard = navigator.clipboard;
            if (!clipboard) return;
            void clipboard
              .writeText(JSON.stringify(settings, null, 2))
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              })
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "コピー済み" : "設定JSONをコピー"}
        </button>
      </div>
    </aside>
  );
}
