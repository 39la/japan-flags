import { CloseIcon, ExternalIcon } from "./icons";
import type { MapFeature, MapProperties, ProfileLoadState } from "./types";

type Props = {
  feature: MapFeature;
  profileState: ProfileLoadState;
  onRetryProfile: () => void;
  onClose: () => void;
};

const methodLabels: Record<string, string> = {
  jawiki_globalusage_exact: "日本語版Wikipedia参照",
  wikidata_p429_filename_enwiki_exact: "Wikidataコード一致",
  wikidata_p429_via_enwiki_usage: "英語版Wikipedia参照",
  filename_variant_sibling: "同名ファイルから補完",
  parent_city_flag_inheritance: "市旗を行政区へ継承",
  parent_city_flag_ward_union: "市旗・行政区ポリゴン統合",
  curated_commons_title_match: "Commons現行旗を確認",
  wikidata_p41: "Wikidata旗画像一致",
};

function formatDate(value: string) {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function formatPopulationDate(value: string | null, precision: number | null) {
  if (!value) return "基準時点不明";
  const [year, month, day] = value.split("-");
  if ((precision ?? 9) >= 11 && day !== "00") {
    return `${year}年${Number(month)}月${Number(day)}日`;
  }
  if ((precision ?? 9) >= 10 && month !== "00") {
    return `${year}年${Number(month)}月`;
  }
  return `${year}年`;
}

function FlagData({ data }: { data: MapProperties }) {
  const isPrefecture = data.entityType === "prefecture";
  return (
    <>
      <div className={`flag-preview${data.flagPath ? "" : " is-missing"}`}>
        {data.flagPath ? (
          <img src={data.flagPath} alt={`${data.displayName}の旗`} />
        ) : (
          <span>旗は未照合です</span>
        )}
      </div>
      <dl>
        <div>
          <dt>{isPrefecture ? "都道府県コード" : "標準地域コード"}</dt>
          <dd>{isPrefecture ? data.prefectureCode : data.jis5}</dd>
        </div>
        <div>
          <dt>境界基準日</dt>
          <dd>{formatDate(data.snapshotDate)}</dd>
        </div>
        <div>
          <dt>旗の照合</dt>
          <dd>
            {data.matchMethod ? (methodLabels[data.matchMethod] ?? data.matchMethod) : "未照合"}
          </dd>
        </div>
      </dl>
      {data.commonsUrl && (
        <a className="commons-link" href={data.commonsUrl} target="_blank" rel="noreferrer">
          Commonsで見る
          <ExternalIcon />
        </a>
      )}
    </>
  );
}

function MunicipalityProfile({ state, onRetry }: { state: ProfileLoadState; onRetry: () => void }) {
  if (state.status === "idle" || state.status === "loading") {
    return (
      <div className="profile-skeleton" aria-live="polite">
        <span />
        <span />
        <span />
        <p>自治体情報を読み込んでいます…</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="profile-error" role="alert">
        <p>自治体情報を読み込めませんでした。</p>
        <button type="button" onClick={onRetry}>
          再試行
        </button>
      </div>
    );
  }
  const profile = state.profile;
  return (
    <>
      <dl className="profile-facts">
        <div>
          <dt>人口</dt>
          <dd>
            {profile.population === null
              ? "情報なし"
              : `${profile.population.toLocaleString("ja-JP")}人`}
            {profile.population !== null && (
              <small>
                {formatPopulationDate(profile.populationAsOf, profile.populationDatePrecision)}
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>面積</dt>
          <dd>
            {profile.areaKm2 === null
              ? "情報なし"
              : `${profile.areaKm2.toLocaleString("ja-JP", {
                  maximumFractionDigits: 2,
                })} km²`}
          </dd>
        </div>
      </dl>
      {profile.wikipediaExtract ? (
        <p className="wikipedia-extract">{profile.wikipediaExtract}</p>
      ) : (
        <p className="profile-missing">Wikipedia概要はありません。</p>
      )}
      <div className="profile-links">
        {profile.wikipediaUrl && (
          <a href={profile.wikipediaUrl} target="_blank" rel="noreferrer">
            Wikipediaで見る
            <ExternalIcon />
          </a>
        )}
        {profile.wikidataUrl && (
          <a href={profile.wikidataUrl} target="_blank" rel="noreferrer">
            Wikidataで見る
            <ExternalIcon />
          </a>
        )}
      </div>
      <small className="profile-attribution">
        出典: Wikipedia / Wikidata。人口は記載された基準時点の値です。
      </small>
    </>
  );
}

export function DetailsDrawer({ feature, profileState, onRetryProfile, onClose }: Props) {
  const data = feature.properties;
  const isPrefecture = data.entityType === "prefecture";

  return (
    <aside className="drawer" aria-label={isPrefecture ? "都道府県の詳細" : "自治体の詳細"}>
      <button className="drawer-close" type="button" aria-label="詳細を閉じる" onClick={onClose}>
        <CloseIcon />
      </button>
      <h2>
        {!isPrefecture && <span>{data.prefectureName}</span>}
        {data.displayName}
      </h2>
      <FlagData data={data} />
      {!isPrefecture ? (
        <section className="municipality-profile" aria-label="基本情報">
          <h3>基本情報</h3>
          <MunicipalityProfile state={profileState} onRetry={onRetryProfile} />
        </section>
      ) : null}
    </aside>
  );
}
