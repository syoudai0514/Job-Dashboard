# Copilot への指示（Job Dashboard）

このリポジトリは、個人のタスク管理ダッシュボードです。GitHub Pages で配信する静的サイトで、ビルド工程はありません。

## 前提

- 画面の言語は日本語。ラベル・メッセージ・コメントも日本語で書く。
- フレームワークは使わない（素の HTML / CSS / JavaScript）。外部ライブラリを足す場合は理由を説明してから。
- スクリプトは `<script>` で順に読み込み（core → schedule → wbs-core → sources-core → store → ai → vendor/exceljs → wbs-sync → sources-sync → ui）、`window.Core` / `Store` / `AI` / `WBS` / `Team` / `UI` のグローバルで連携する。ES Modules に移行する場合は全ファイルまとめて行う。
- データはブラウザの localStorage（キー `job-dashboard:v1`）にのみ保存する。社外への送信を追加しない。AI への送信は、ユーザーが設定画面で明示的に登録した接続先に限る。

## 責務の分け方

- `js/core.js` / `js/schedule.js` / `js/wbs-core.js` / `js/sources-core.js`: 画面に依存しない純粋関数だけを置く（DOM・localStorage に触らない）。日付は `YYYY-MM-DD` 文字列で扱う。ここに追加したロジックには必ず `tests/core.test.js` にテストを足す。
- `js/store.js`: 状態の変更は必ず Store のメソッド経由で行い、`save()` で保存と再描画通知をする。保存先を変えるときはこのファイルだけを差し替える。
- `js/wbs-sync.js`: Excel ファイルの読み書きだけを担当する。同期の判定（どちらの値を採るか）は `Core.mergeRecord` に置き、ここには書かない。Excel への書き込みが成功するまで `wbsBase`（前回同期の値）を確定させないこと（失敗時に変更が巻き戻るのを防ぐため）。
- `js/ui.js`: 描画は `innerHTML` のテンプレート文字列、操作は `data-action` 属性によるイベント委譲。ユーザー入力を埋め込むときは必ず `h()` でエスケープする。
- `css/style.css`: 色・フォントは `:root` の変数だけを使う。ダークモード用の値は `prefers-color-scheme` と `[data-theme="dark"]` の両方に定義する。

## データ形式・ルール

README の「データ形式」「優先度スコアのルール」を正とする。フィールドを増やすときは `store.js` の `normalize()` で古いデータにも既定値が入るようにする。

## WBS 同期のルール

- 行の対応は「ID」列。見出しは `Core.WBS_FIELDS` の候補名で探す。列を追加するときはここに足す。
- 両方で変わった項目は、`Core.WBS_EXEC_KEYS`（状態・進捗・完了日）はダッシュボード、それ以外は Excel を優先する。
- Excel から消えた行は自動で削除しない（ユーザーに確認する）。
- 同期による Store の変更は `meta.source = 'wbs'` を付け、同期のきっかけにしない（無限ループ防止）。
- 変更したら `tests/wbs.test.js` を更新する。

## チームWBS（取込元）のルール

- チームWBSは計画の正。計画の項目（`Core.SOURCE_PLAN_KEYS`）は、チームWBSで変わったら個人に反映する（両方で変わったらチームWBSが勝つ）。
- 実行の項目（`Core.SOURCE_EXEC_KEYS`）は個人が正。取込元の `mode` が `'write'` のときだけチームWBSに書き戻す。
- 新着は自動で取り込まない。本人が選ぶ。チームWBSから消えた・担当が外れたタスクも自動で消さない。
- 判定は `Core.reconcileSource` に置き、`sources-sync.js` はファイルの読み書きだけを行う。変更は `meta.source = 'team'`、取込元の情報更新は `'team-meta'` で保存する。
- 変更したら `tests/sources.test.js` と `tests/e2e/team-wbs.e2e.js` を更新する。

## AI 連携

- プロンプトは `Core.buildPrompt(mode, ctx)` に集約する。回答の最後に JSON を出すよう指示し、`Core.extractJSON` と `Core.proposalsFrom` で「変更案」に変換して、ユーザーが選んだものだけ反映する。AI の回答を確認なしにデータへ書き込まない。
- 新しい相談モードを足すときは `Core.AI_MODES`、`Core.buildPrompt`、`Core.proposalsFrom`、`ui.js` の `viewAI` と `aiApply` の5か所を更新する。

## 確認

- `npm install && npm test` が通ること。
- 幅 400px 程度のスマートフォン表示で横スクロールが出ないこと。
