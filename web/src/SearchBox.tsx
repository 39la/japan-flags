import { useMemo, useState } from "react";
import { SearchIcon } from "./icons";
import type { MapFeature, MapLayer } from "./types";

type Props = {
  features: MapFeature[];
  layer: MapLayer;
  onSelect: (feature: MapFeature) => void;
};

const normalize = (value: string) => value.normalize("NFKC").replaceAll(/\s+/g, "").toLowerCase();

export function SearchBox({ features, layer, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const results = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return [];
    return features
      .filter((feature) => feature.properties.entityType !== "unassigned")
      .filter((feature) => {
        const { displayName, prefectureName } = feature.properties;
        const code =
          feature.properties.entityType === "prefecture"
            ? feature.properties.prefectureCode
            : feature.properties.jis5;
        const wardTerms =
          feature.properties.entityType === "prefecture"
            ? ""
            : `${(feature.properties.wardNames ?? []).join("")}${(
                feature.properties.memberJis5s ?? []
              ).join("")}`;
        return normalize(`${prefectureName}${displayName}${code}${wardTerms}`).includes(needle);
      })
      .slice(0, 8);
  }, [features, query]);

  return (
    <div className="search">
      <SearchIcon />
      <input
        aria-label={layer === "prefecture" ? "都道府県を検索" : "自治体を検索"}
        placeholder={layer === "prefecture" ? "都道府県を検索" : "自治体を検索"}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
      />
      {focused && query && (
        <div className="search-results" role="listbox">
          {results.length ? (
            results.map((feature) => (
              <button
                key={
                  feature.properties.entityType === "prefecture"
                    ? feature.properties.mapPart
                    : feature.properties.territoryVersionId
                }
                role="option"
                aria-selected="false"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onSelect(feature);
                  setQuery(
                    `${feature.properties.prefectureName} ${feature.properties.displayName}`,
                  );
                  setFocused(false);
                }}
              >
                <span>
                  {feature.properties.prefectureName}{" "}
                  <strong>{feature.properties.displayName}</strong>
                </span>
                <span className="jis">
                  {feature.properties.entityType === "prefecture"
                    ? feature.properties.prefectureCode
                    : feature.properties.jis5}
                </span>
              </button>
            ))
          ) : (
            <p>該当する自治体がありません</p>
          )}
        </div>
      )}
    </div>
  );
}
