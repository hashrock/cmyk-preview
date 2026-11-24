# CMYK Preview

画像をドロップすると、印刷（CMYK）での見え方をブラウザ上でシミュレーションするツール。
色変換は [LittleCMS](https://github.com/mm2/Little-CMS)（[lcms-wasm](https://github.com/mattdesl/lcms-wasm)）と ICC プロファイルで、Web Worker 内で行う。

```sh
pnpm install
pnpm dev
```

## 機能

- 画像のドロップ / クリックで選択 / ⌘V で貼り付け（長辺 4096px を超える画像は縮小して処理）
- 入力 RGB の扱い：埋め込みプロファイルに従う（PNG / JPEG / WebP から ICC を抽出。なければ sRGB）/ sRGB・Adobe RGB・Display P3 として扱う
- 出力プロファイル：Japan Color 2011 Coated、FOGRA39L Coated（同梱）。`.icc` / `.icm` をドロップして追加もできる
- レンダリングインテント（知覚的 / 相対的な色域を維持 / 彩度）、黒点の補正、紙色のシミュレーション
- 表示：RGB と CMYK の比較スライダー、各版（C/M/Y/K）、総インキ量の上限超過、色域外警告（ΔE しきい値）
- 3D 雑誌プレビュー：見開きの誌面として机の上に置いた状態をレンダリング。紙質（コート / マット / 上質 / 新聞）、照明（昼光 / 室内灯 / 窓際）、RGB・CMYK 切替、スクリーンショット保存
- カーソル位置の RGB / CMYK % / 総インキ量 / ΔE を表示
- 表示中の画像を PNG で保存

キー操作：`1`〜`9`・`0`（3D）で表示切替、`Space` で RGB / CMYK 切替、`F` でフィット / 等倍。

## ICC プロファイルについて

同梱しているのは再配布可能な次の 2 つ（出典と条件は [public/profiles/LICENSES.md](public/profiles/LICENSES.md)）。

- Japan Color 2011 Coated（ICC Profile Registry）
- FOGRA39L Coated（CTAN `colorprofiles`）

Adobe RGB 互換 / Display P3 の入力プロファイルは `src/icc-gen.ts` で原色・白色点・トーンカーブの定義から実行時に生成している。
それ以外（Japan Color 2001 など）は `public/profiles/` に置けば読み込まれる（`.gitignore` 済み）。画面に `.icc` をドロップして追加することもできる。
