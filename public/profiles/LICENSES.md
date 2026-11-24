# 同梱 ICC プロファイルの出典とライセンス

## JapanColor2011Coated.icc

- 出典: ICC Profile Registry — https://registry.color.org/profile-registry/JapanColor2011Coated
- 提供: Japan Printing Machinery Association / Copyright X-Rite, Inc.
- 条件（レジストリ記載）: "may be used, embedded, exchanged, and shared without restriction. However, it may not be altered, or sold (whether standing alone or incorporated into commercial products) without written permission of X-Rite."
- ファイルは無改変のまま同梱している。

## FOGRA39L_coated.icc

- 出典: CTAN `colorprofiles` パッケージ — https://ctan.org/tex-archive/support/colorprofiles
- 作成者は権利を放棄しており、プロファイル内に "This profile is free of known copyright restrictions" と記載されている（同パッケージの README を参照）。

## その他

上記以外の `.icc`（Japan Color 2001 など）は手元のアプリから複製したローカル専用ファイルで、`.gitignore` で除外している。
Adobe RGB 互換 / Display P3 の入力プロファイルは `src/icc-gen.ts` で実行時に生成している。
