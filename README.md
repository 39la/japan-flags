# 地方旗ビューワー

Wikimedia Commonsの自治体旗SVG、国土数値情報N03の行政区域、Wikidata・Wikipediaの
自治体情報を収集し、SQLiteとWeb地図へ変換するプロジェクトです。

ソースコード：<https://github.com/aluqas/japan-flags>

Pythonはuv、WebはDeno、環境と共通タスクはmiseで管理します。Web地図は
React、TypeScript、Vite、Canvasで構成し、全国47都道府県の都道府県旗・市区町村旗を
同じ描画パイプラインで表示します。

## Quick start

```sh
mise install
mise run setup
mise run dev
```

`mise run dev`は既存の生成済み地図データを使用し、外部データ取得や全件exportを
実行しません。生成物がない場合だけ、先に次を実行してください。

```sh
mise run generate
```

`generate`は全国データ、旗SVG、アトラスを再生成するため時間がかかります。

## よく使うタスク

```sh
mise run dev       # Vite開発サーバー
mise run check     # Python/Webのformat、lint、型検査、test
mise run build     # 既存生成物からproduction build
mise run data:fetch-sources         # 外部ソース取得 → SQLite照合
mise run data:fetch-sources-refresh # 取得キャッシュを無視して全ソースを再取得
mise run generate  # データexport → 旗asset生成 → 静的検証
mise run render:maps # Canvas地図を全国・地方・都道府県別画像へ出力
mise run deploy       # 検証後Cloudflare Workers Static Assetsへデプロイ
mise run ci        # frozen setup → check → build
mise tasks         # 全タスクを表示
```

データ取得・照合などの運用タスクは`data:*`、旗asset生成は`assets:*`、個別の検証は
`py:*`と`web:*`へ分けています。基準日は[`.mise.toml`](.mise.toml)の
`snapshot_date`で一元管理します。

## リポジトリ構造

```text
src/japan_flags/        Pythonパッケージ、収集・照合・export
tests/                  Pythonテスト
web/src/                ReactアプリとCanvas描画パイプライン
web/scripts/            旗asset生成・生成物検証・レポート
web/public/             Web配信用の生成済みデータと旗asset
data/raw/               外部から取得した原本・応答
data/assets/            Commons SVGなどの永続入力
data/derived/           比較・検査用の派生データ
docs/architecture/      現在の設計
docs/operations/        セットアップ・更新・計測手順
docs/decisions/         重要な設計判断
scripts/                外部ソース取得などの運用スクリプト
.mise/tasks/            責務別のmiseタスク
```

ソース、入力キャッシュ、派生物、build出力の扱いは
[データ更新手順](docs/operations/data-refresh.md)を参照してください。

## ドキュメント

- [アーキテクチャ概要](docs/architecture/overview.md)
- [描画パイプライン](docs/architecture/rendering.md)
- [SQLiteとデータモデル](docs/architecture/data-model.md)
- [旗SVG・意匠・アトラス](docs/architecture/flag-assets.md)
- [環境セットアップ](docs/operations/setup.md)
- [データ更新](docs/operations/data-refresh.md)
- [プロファイリング](docs/operations/profiling.md)
- [地図画像の一括出力](docs/operations/map-rendering.md)
- [Cloudflareへのデプロイ](docs/operations/deployment.md)
- [出典・ライセンス表示](NOTICE.md)
- [Geoshape歴史的行政区域データセット検討メモ](docs/notes/geoshape-historical-boundaries.md)
- [コントリビューション](CONTRIBUTING.md)

## ライセンスと出典

本リポジトリのソースコードはCopyright © 2026 saqula、[MIT License](LICENSE)です。
行政区域、Commons、Wikidata、Wikipedia由来データは、それぞれの出典・ライセンス・
利用条件に従います。外部取得物と生成物を再配布する場合は、保存された出典情報も
確認してください。
