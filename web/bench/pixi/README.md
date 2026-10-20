# Preact + PixiJS prototype

既存のReact / Canvas 2D実装とは独立した描画プロトタイプです。

市区町村polygonと旗を事前に1枚のSVGへ合成し、PixiJSで単一Texture・単一Spriteとして描画します。Preactはロード状態、操作ボタン、簡易計測UIのみを担当します。

## 起動

```sh
mise run bench:install
mise run bench:check
mise run bench:dev
```

production build:

```sh
mise run bench:build
```

ベースマップを再生成する場合:

```sh
mise run bench:bake-basemap-force
```

## 描画パイプライン

```text
React版のSVG export
  -> japan-basemap.svgへ事前合成
  -> Pixi Assets.loadでTexture化
  -> Sprite 1個をContainerへ追加
  -> pan / zoomはContainer transformのみ更新
  -> requestAnimationFrame単位のon-demand render
```

## 実装上の比較点

| 項目 | React版 | prototype |
| --- | --- | --- |
| UI | React | Preact |
| 描画 | Canvas 2D + Path2D | PixiJS / WebGL |
| 地物数 | 約1,700 Feature | Sprite 1個 |
| pan / zoom | scene cache転写 | Container transform |
| idle時 | Canvas更新なし | Pixi ticker停止 |
| hit test | color hit map | 未実装 |
| LOD / fit切替 | 動的 | 固定 |

## 操作

- ドラッグ: pan
- ホイール、＋／−: zoom
- 全国: camera reset
- JSON export: startup、Texture load、render時間を出力

## 制約

- SVGは約17MBあり、初回Texture化とGPUメモリ消費は軽くありません。
- hit test、Feature選択、動的LOD、fit mode切替は未実装です。
- 高倍率ではSVG Textureのラスター解像度上限が見えます。
- WebGL初期化に失敗した場合のCanvas 2D fallbackはありません。
