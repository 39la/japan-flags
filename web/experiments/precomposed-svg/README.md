# 事前合成SVG描画実験

画像出力パイプラインが生成した自己完結SVGを、ブラウザで1枚の画像として操作する
実験フロントです。現行のFeature単位Canvas描画とは独立しています。

## 起動

先に`data/derived/map-renders/<snapshot-date>/`へ全国・都道府県別のSVGとWebPを
生成してください。既定では`20260101`を参照します。

```sh
mise run web:dev-precomposed-svg
```

別のsnapshotを使う場合は環境変数で指定できます。

```sh
SNAPSHOT_DATE=20260731 mise run web:dev-precomposed-svg
```

production buildは次で生成します。

```sh
mise run web:build-precomposed-svg
```

## 比較項目

- 全国1枚と東京都1枚
- 自己完結SVGとWebP
- CSS compositorの`transform`とCanvasの`drawImage`
- decode時間、転送サイズ、240フレームの平均・p95・20ms超過回数

既定値は東京都のSVGです。`?asset=webp`でWebP、`?scope=national`で全国を初期選択
できます。全国SVGは約17MBあり、decode中にブラウザが長時間応答しなくなる可能性が
あります。

## 制約

この実験は、合成済み画像のパン・ズームだけを比較します。自治体ごとのヒットテスト、
選択・ホバー、検索、動的な旗配置方式、可視範囲に応じた詳細LOD差し替えは含みません。
これらを追加する場合も、操作用の軽量なgeometry indexは別途必要です。
