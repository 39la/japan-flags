import { useEffect } from "react";
import { CloseIcon, ExternalIcon } from "./icons";

type Props = {
  snapshotDate: string;
  onClose: () => void;
};

function formatSnapshotDate(value: string) {
  if (!/^\d{8}$/.test(value)) return value;
  return `${value.slice(0, 4)}年${Number(value.slice(4, 6))}月${Number(value.slice(6, 8))}日`;
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalIcon />
    </a>
  );
}

export function CreditsDialog({ snapshotDate, onClose }: Props) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="credits-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="credits-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="credits-title"
      >
        <button
          className="credits-close"
          type="button"
          aria-label="閉じる"
          onClick={onClose}
          autoFocus
        >
          <CloseIcon />
        </button>
        <h2 id="credits-title">出典・ライセンス</h2>
        <p className="credits-lead">
          このサイトは複数のオープンデータとメディアを加工・統合しています。各提供元は本サイトを
          保証・推奨するものではありません。
        </p>

        <section>
          <h3>行政区域・海岸線</h3>
          <p>
            出典：国土交通省「国土数値情報（行政区域データ N03）」 （
            {formatSnapshotDate(snapshotDate)}時点）。
            当サイトで座標量子化、形状簡略化、TopoJSON変換、政令指定都市の行政区統合を行っています。
          </p>
          <div className="credits-links">
            <ExternalLink href="https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html">
              行政区域データ
            </ExternalLink>
            <ExternalLink href="https://nlftp.mlit.go.jp/ksj/other/agreement.html">
              国土数値情報の利用規約
            </ExternalLink>
            <ExternalLink href="https://creativecommons.org/licenses/by/4.0/deed.ja">
              CC BY 4.0
            </ExternalLink>
          </div>
        </section>

        <section>
          <h3>都道府県旗・市区町村旗</h3>
          <p>
            旗SVGはWikimedia
            Commons掲載ファイルを参照しており、Web配信用の最適化などの処理を行っています。
            権利者、作者、ライセンス条件はファイルごとに異なります。
            各地域の詳細欄にある「Commonsで見る」から、元ファイルの作者・出典・ライセンスを確認できます。
            当サイトはいかなる自治体、政府、行政機関とも関係はなく、また誤解を招く意図もありません。
          </p>
          <div className="credits-links">
            <ExternalLink href="https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia/ja">
              Commonsの再利用案内
            </ExternalLink>
          </div>
        </section>

        <section>
          <h3>自治体情報</h3>
          <p>
            人口、面積、識別子はWikidataの構造化データを利用しています。Wikidataの構造化データはCC0です。
            自治体概要は日本語版Wikipediaの記事冒頭をプレーンテキスト化したもので、元記事へのリンクを併記しています。
            Wikipedia本文の再利用部分にはCC BY-SA 4.0などが適用されます。
          </p>
          <div className="credits-links">
            <ExternalLink href="https://www.wikidata.org/wiki/Wikidata:Licensing/ja">
              Wikidataのライセンス
            </ExternalLink>
            <ExternalLink href="https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use/ja">
              Wikimedia利用規約
            </ExternalLink>
            <ExternalLink href="https://creativecommons.org/licenses/by-sa/4.0/deed.ja">
              CC BY-SA 4.0
            </ExternalLink>
          </div>
        </section>

        <section>
          <h3>本サイト</h3>
          <p>
            ソースコードはMIT Licenseで公開しています。
            外部由来のデータ、文章、画像等の権利は各提供元・権利者に帰属します。
          </p>
          <div className="credits-links">
            <ExternalLink href="https://github.com/aluqas/japan-flags">ソースコード</ExternalLink>
            <ExternalLink href="https://github.com/aluqas/japan-flags/blob/main/LICENSE">
              MIT License
            </ExternalLink>
          </div>
        </section>
      </section>
    </div>
  );
}
