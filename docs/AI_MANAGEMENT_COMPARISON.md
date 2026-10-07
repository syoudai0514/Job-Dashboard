# AI駆動開発の管理方法 比較と本方式の評価

| 項目 | 内容 |
| --- | --- |
| 目的 | AI駆動開発（AIを前提にした開発・業務遂行）の管理方法を「標準的・推奨的・先進的」に分けて比較し、本ダッシュボードの方式（3層WBS＋AI）のメリット・デメリットを整理する |
| 調査時点 | 2026年10月 |
| 関連文書 | [DESIGN.md](DESIGN.md)（本方式の設計書） |
| 注意 | 各手法は変化が速く、出典の一部は二次情報（解説記事・報道）である。数値や機能は導入前に一次情報（各社の公式文書）で確認すること。出典は末尾に記載 |

---

## 1. 結論（要約）

- **標準的**なのは、今のやり方（アジャイル・WBS・カンバン）はそのままに、AIを「個人の補助」として足す方法。導入は簡単だが、効果は個人止まりになりやすい。
- **推奨的**なのは、DORA の「AI能力モデル」に沿って **方針・文脈（コンテキスト）・小さな単位・人の承認** を整えたうえで、仕様書を起点に AI に作業させる方法（仕様駆動開発）。研究の裏付けがあり、品質を保ちやすい。
- **先進的**なのは、AI を「作業の担い手」として課題を直接割り当て、人は意図の確認と承認に回る方法（AWS の AI-DLC、GitHub のコーディングエージェント）。速いが、統制と検証の負荷が上がる。
- **本方式（3層WBS＋AI）** は、推奨的な方法の考え方（決める人を項目ごとに1つにする、人が承認する、小さく分ける）を、**開発以外の業務も含むタスク管理** に当てはめたもの。統制しやすく小さく始められる一方、**コードやプルリクエストとはつながっておらず、AI の自律度は低い**。開発チームで使うなら、GitHub Issues・コーディングエージェントとの連携を次の段階に置くのがよい。

---

## 2. 分類の考え方

| 区分 | 定義 | 人の役割 | AIの役割 |
| --- | --- | --- | --- |
| 標準的 | 多くの組織がすでにやっている方法。既存の管理手法に AI ツールを足す | 計画も実行も人 | 個人の補助（補完・要約・下書き） |
| 推奨的 | 研究や業界団体が成果との相関を示し、勧めている方法 | 意図と仕様を決め、各段階で承認する | 仕様に沿って作業する。人の承認を通る |
| 先進的 | 先行企業が取り組み始めている方法。AI が作業の主な担い手になる | 意図の確認、検証、最終承認 | 課題を受け取り、計画・実装・レビューまで進める |

---

## 3. 手法の比較

### 3.1 一覧

| | ① 既存手法＋AI補助 | ② PMツール内蔵AI | ③ DORA AI能力モデル | ④ 仕様駆動開発 | ⑤ AI-DLC（AWS） | ⑥ コーディングエージェント運用 | ★ 本方式（3層WBS＋AI） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 区分 | 標準的 | 標準的〜推奨的 | 推奨的（組織の土台） | 推奨的 | 先進的 | 先進的 | 推奨的の考え方を業務管理に適用 |
| 代表例 | Scrum / カンバン / WBS ＋ Copilot | Microsoft Planner エージェント、Jira の Rovo エージェント | 2025年 DORA レポート | GitHub Spec Kit、Kiro | AWS AI-DLC、awslabs/aidlc-workflows | GitHub Copilot コーディングエージェント、Agent HQ | 本リポジトリ |
| 計画の単位 | スプリント・WBS | プラン・課題 | 小さな変更 | 仕様 → 計画 → タスク | 意図 → ユニット → Bolt（時間〜日） | 課題（Issue） | チームWBS → 個人WBS → 今日やる |
| 正となる成果物 | バックログ・WBS | ツール内のプラン | 組織の仕組み | spec / plan / tasks の Markdown | 要件・ユニット・設計 | Issue と PR | Excel の WBS（項目ごとに正を決める） |
| AIの自律度 | 低 | 中（状況報告・下書き） | 手法ではなく土台 | 中（仕様の範囲で実装） | 高（AI が問い・提案し、人が検証） | 高（PR まで作る） | 低〜中（提案だけ。反映は人が選ぶ） |
| 人の承認 | 暗黙 | ツール次第 | 必須（方針として明示） | 段階ごとのゲート | 段階ごとのゲート、チームでの合同確認 | PR レビュー | 変更案ごとに本人が選ぶ。共通WBSへの書き込みは権限者のみ |
| サイクル | 1〜4週間 | ツール次第 | — | 機能ごと | 時間〜日（Bolt） | 課題ごと（分〜時間） | 毎日（今日やる）＋変更は数秒で反映 |
| 対象 | 何でも | 業務全般 | ソフトウェア組織 | ソフトウェア開発 | ソフトウェア開発 | ソフトウェア開発 | 業務全般（開発・標準化・育成・事務など） |
| 導入の難しさ | 低 | 低（ライセンス次第） | 中〜高（組織の改善） | 中 | 高（プロセスの作り直し） | 中（権限・CI・レビュー体制） | 低（Excel とブラウザだけ） |

### 3.2 各手法の要点とメリット・デメリット

#### ① 既存手法＋AI補助（標準的）

今のアジャイルや WBS 運用はそのままに、Copilot のコード補完・チャット、議事録の要約などを個人が使う。

| メリット | デメリット |
| --- | --- |
| すぐ始められ、教育コストが低い | 効果が個人に閉じ、チームの計画や品質に結びつきにくい |
| 既存の管理手法・帳票を変えなくてよい | AI 利用のルールがないと、使い方がばらつき、情報漏えいのリスクも残る |
| | 体感ほど速くならないことがある。熟練開発者を対象にした 2025年の実験（METR）では、AI を使ったほうが作業時間が19%長く、本人は「20%速くなった」と感じていた |

#### ② PMツール内蔵のAI（標準的〜推奨的）

Microsoft Planner のエージェント（旧 Project Manager エージェント）はプランから状況報告を作り、タスクの下書きや進捗の追跡を行う。Atlassian の Rovo は Jira・Confluence の情報をもとにエージェントを作れる。

| メリット | デメリット |
| --- | --- |
| 既存の業務ツールの中で完結し、権限管理・監査もツールに任せられる | 有償ライセンスが前提。ツールに閉じ、Excel など既存資産とつながりにくい |
| 状況報告などの定型作業を自動化できる | ツール内のデータの質に依存する（項目が空欄・不統一だと誤る） |
| | 管理の考え方（何を正とするか）はツールの仕様に従うことになる |

#### ③ DORA AI能力モデル（推奨的・組織の土台）

Google の DORA は、約5,000人の調査と78件のインタビューから、AI の効果を高める7つの能力を示した。要点は「**AI は増幅器**」で、強い組織はより強く、弱い組織は弱点がより目立つ。AI の利用は処理量（スループット）の向上と相関する一方、変更失敗や手戻り（不安定さ）の増加とも相関するとされる。

| 7つの能力 | 内容 |
| --- | --- |
| 明確に伝えられた AI 方針 | 使ってよいツールと使い方を決めて伝える |
| 健全なデータ基盤 | データの質・整備 |
| AI が使える社内データ | 社内文書やコードを AI に渡す（プロンプトより「コンテキスト」を整える） |
| 確かなバージョン管理 | 変更履歴と戻せる仕組み |
| 小さな単位で進める | AI が大量に作るほど、変更を小さく保つ |
| 利用者中心 | 利用者を見ずに AI を入れたチームは成果が下がった |
| 質の高い社内プラットフォーム | 個人の速さが、後工程のボトルネックで消えないようにする |

| メリット | デメリット |
| --- | --- |
| 大規模調査に基づき、投資の優先順位を説明しやすい | 「手法」ではなく組織の土台なので、日々の進め方は別に決める必要がある |
| ツールが変わっても通用する | 組織全体の改善が必要で、時間がかかる |

#### ④ 仕様駆動開発（推奨的）

先に仕様を書き、仕様 → 技術計画 → タスク → 実装 の順に、各段階で人が承認してから AI に進ませる。GitHub Spec Kit は Specify / Plan / Tasks / Implement の4段階で、各段階の Markdown を次の段階に渡す。AWS の Kiro は requirements.md / design.md / tasks.md を作り、要件を EARS 形式（「〜のとき、システムは〜する」）で書く。

| メリット | デメリット |
| --- | --- |
| AI に渡す文脈が構造化され、出力が安定する | 仕様を書く手間がかかり、小さな修正には重い |
| 段階ごとのゲートで、人が意図を確認できる | 実装後の運用・保守までは面倒を見ない、という評価もある |
| 仕様がそのまま記録になる | ソフトウェア開発向けで、業務タスク全般には向かない |

#### ⑤ AI-DLC（AWS、先進的）

AWS が提唱する「AI 駆動の開発ライフサイクル」。開始（Inception）・構築（Construction）・運用（Operations）の3段階で、AI が問いを立てて要件・ユーザーストーリー・作業単位（ユニット）を提案し、チーム全員でその場で確認する（**Mob Elaboration**）。スプリントの代わりに、時間〜日単位の短いサイクル **Bolt** で回す。オープンソースの実装（aidlc-workflows）は、各段階の終わりに承認ゲートを置く。

| メリット | デメリット |
| --- | --- |
| 要件定義から実装までが短いサイクルで回る | プロセスの作り直しが必要で、組織の合意形成が重い |
| AI が問いを立てるため、要件の抜け漏れが減る | チーム全員が同時に参加する儀式が前提 |
| 人は「意図と検証」に集中できる | 公開情報の多くは解説記事で、効果の数値は検証されていない |

#### ⑥ コーディングエージェント運用（先進的）

課題（Issue）を AI に直接割り当て、AI がブランチを切って下書きのプルリクエストを作る。GitHub の Agent HQ では Copilot に加えて Claude や Codex なども同じ仕組みで割り当てられ、進行状況（待機中・作業中・レビュー待ち・完了）が課題やプロジェクトに表示される。リポジトリに AGENTS.md（エージェント向けの作業ルール）を置くのが一般的になり、2025年12月に Linux Foundation の Agentic AI Foundation の管理下に入った。

| メリット | デメリット |
| --- | --- |
| 定型的な課題を並列で片付けられる | 生成量が増えるほど、レビューと検証が新たなボトルネックになる |
| 作業の記録（課題・PR・CI）が自然に残る | 権限・CI・レビュー体制を整えないと品質が崩れる |
| 管理の単位が課題になり、進捗が見える | 開発以外の業務には使えない。ライセンス費用 |
| | エージェント型 AI のプロジェクトは、費用・価値の不明確さ・統制の弱さから、2027年末までに40%超が中止されるとの予測（Gartner）もある |

---

## 4. 本方式（3層WBS＋AI）の位置づけ

### 4.1 構成のおさらい

| 層 | 決める人 | 内容 |
| --- | --- | --- |
| 計画層：チームWBS（複数） | 上位者・PM | タスク名・担当・期限・見積。ダッシュボードは常に読み取り、新着・変更・遅延を知らせる |
| 実行層：個人WBS＋ダッシュボード | 本人 | 状態・進捗。権限がある人だけチームWBSに書き戻す |
| AI | 提案のみ | 変更・遅延・ボトルネックを読み、打ち手・計画の引き直し・報告文を提案。反映は本人が選ぶ |

### 4.2 各手法の考え方との対応

| 各手法の考え方 | 本方式での実現 | 程度 |
| --- | --- | --- |
| 仕様・計画を正にし、段階ごとに人が承認（④⑤） | チームWBSを計画の正にし、新着の取り込み・AI の変更案は本人が選ぶ | ○ |
| 小さな単位で進める（③） | 所要日数の逆算、タスク分解の AI 相談、「今日やる」を容量内に収める | ○ |
| AI に文脈を渡す（③ AI が使える社内データ） | 相談ごとに、タスク・期限・余裕・ボトルネック・チームWBSの変更を自動で添える | ○ |
| AI 方針の明示（③） | 既定はコピー＆ペースト（社内で許可された AI のみ）、AI の回答を確認なしに書き込まない | △（ツール側の工夫。組織の方針は別途必要） |
| 状況報告の自動化（②） | 日報・週次振り返り・上長への報告文を AI と作る | △（半自動） |
| AI が問いを立てて要件を詰める（⑤ Mob Elaboration） | 壁打ち・メモからタスク化はあるが、チームでの合同確認はない | × |
| AI が作業そのものを担う（⑥） | 対象外（タスク管理のみ。コードや PR は作らない） | × |
| バージョン管理・監査（③⑥） | 同期ログ・変更の通知・タスクの経過ログはあるが、Git のような履歴・差し戻しはない | △ |

---

## 5. 本方式のメリット・デメリット

### 5.1 メリット

| # | メリット | 根拠・比較 |
| --- | --- | --- |
| 1 | **導入の壁が低い。** Excel とブラウザだけで始められ、サーバーもライセンスも不要 | ②⑥はライセンス、⑤はプロセスの作り直しが必要 |
| 2 | **既存の WBS をそのまま使える。** 見出し名で列を探すので、今の Excel の形式を大きく変えなくてよい | ②はツール移行、④⑤は新しい成果物が必要 |
| 3 | **決める人が項目ごとに明確。** 計画はチームWBS、実行は本人。競合時の勝ち負けも決まっている | 「誰の変更が正か」が曖昧だと、AI が増幅する（③の指摘） |
| 4 | **AI の統制がしやすい。** AI は提案のみ、反映は人が選ぶ。共通WBSへの書き込みは権限者だけ | 統制の弱さはエージェント型 AI の失敗要因の一つ（Gartner）。AI 利用のルール整備は多くの現場で未整備（PMI アイルランド支部の調査で83%） |
| 5 | **上流の遅れが見える。** 他メンバー担当の先行タスクの遅延、着手期限の食い込み、ボトルネックを個人の画面で知らせる | ①②では個人の画面まで届きにくい |
| 6 | **開発以外の業務にも使える。** 標準化・育成・事務・定例作業まで同じ仕組みで管理できる | ④⑤⑥はソフトウェア開発向け |
| 7 | **情報が外に出にくい。** データは本人のブラウザと選んだファイルだけ。AI は社内で許可されたものに手で貼る | クラウドツールへのデータ集約が不要 |
| 8 | **小さく始めて段階的に広げられる。** 個人 → チーム → 複数チームと広げられ、保存先だけ差し替える設計 | ⑤は最初から組織全体の変更が必要 |

### 5.2 デメリット

| # | デメリット | 影響 | 対策の方向 |
| --- | --- | --- | --- |
| 1 | **AI駆動「開発」そのものとはつながっていない。** タスク管理であり、コード・PR・CI とは連携しない | 開発チームでは、WBS と GitHub の二重管理になる | WBS のタスクを GitHub Issues と紐づけ、コーディングエージェントに割り当てられるようにする |
| 2 | **AI の自律度が低い。** コピー＆ペースト中心で、AI が自分から動くことはない | ⑤⑥ほどの速度は出ない。相談の手間が残る | 社内 AI ゲートウェイ経由の直接接続、定時の自動分析（朝の計画案の自動作成など） |
| 3 | **計画層が人の手入力に依存。** チームWBSの更新が遅れると全員に影響する | 上位者の更新作業がボトルネックになりうる | ⑤の Mob Elaboration のように、AI が WBS の分解案を出し、チームで確認して確定する |
| 4 | **Excel ファイル同期の限界。** 開いている間は書き込めない、同時編集に弱い、グラフ等が消えることがある | 人数・ファイル数が増えると「書き戻し待ち」が増える | SharePoint 上の Excel を Microsoft Graph API で読み書き。規模が大きければ Lists / Planner / Project に移行 |
| 5 | **データが端末ごと。** 個人の状態はブラウザに保存される | PC の入れ替えで失う。チームの指標を集計できない | JSON の書き出し。将来は社内 API への保存 |
| 6 | **成果の測定ができない。** DORA の4指標（変更のリードタイム・デプロイ頻度・変更失敗率・復旧時間）のような指標を取らない | 導入効果を説明しにくい | 完了数・遅延数・着手期限の遵守率など、業務向けの指標を定義して集計する |
| 7 | **チームでの合意形成の場がない。** 個人の画面が中心で、チーム全体の計画会議を支援しない | 計画の質は上位者個人に依存する | チーム全体の状況画面をもとに、週次で AI の分析を共有する場を作る |
| 8 | **判定の精度に限界。** 担当は名前の一致、稼働日は祝日を考慮しない | 新着の漏れ、着手期限のずれ | 担当欄の表記統一、祝日カレンダーの追加 |

### 5.3 向いている場面・向かない場面

| 向いている | 向かない |
| --- | --- |
| Excel の WBS が既にあり、ツールを変えずに AI を取り入れたい | 開発の大半をコーディングエージェントに任せたい（⑥の方が合う） |
| 開発以外の業務（標準化・育成・社内業務）も一緒に管理したい | 数十人以上が同じ WBS を同時に更新する |
| AI の利用ルールが固まっておらず、まずは「人が承認する」形で始めたい | チームの成果指標（DORA 指標など）を継続的に測りたい |
| 上位者の計画と個人の実行のずれ・遅延を早く見つけたい | 要件定義そのものを AI と短いサイクルで回したい（⑤の方が合う） |

---

## 6. 今後の進め方（提案）

本方式を土台にして、推奨的・先進的な手法の良いところを段階的に取り込む。

| 段階 | 内容 | 取り込む考え方 | 主な作業 |
| --- | --- | --- | --- |
| 1（現在） | 3層WBS＋AI 提案。個人とチームの同期 | ③ 小さな単位・人の承認 | チームでの試行、担当欄の表記統一、AI 利用方針の明文化 |
| 2 | 開発タスクを GitHub とつなぐ | ④ 仕様駆動、⑥ コーディングエージェント | WBS の開発タスクに Issue / 仕様書（spec）のリンク列を追加。Issue と PR の状態を進捗に反映。定型タスクは Copilot コーディングエージェントに割り当て |
| 3 | 計画層を共有基盤へ | ② PMツール、③ 社内プラットフォーム | SharePoint の Excel を Graph API 経由で読み書き、または Lists / Planner へ移行。ファイルロックの解消 |
| 4 | AI が計画づくりから参加 | ⑤ AI-DLC の Mob Elaboration | 新しい案件で、AI が WBS の分解・リスク・見積の案を出し、チームで確認して確定する場を設ける |
| 5 | 効果の測定 | ③ DORA の考え方 | 遅延率・着手期限の遵守率・手戻りなどの指標を集計し、四半期ごとに振り返る |

### DORA 7能力の自己点検（本方式を入れたチーム向け）

| 能力 | 本方式で満たせること | 別途必要なこと |
| --- | --- | --- |
| 明確に伝えられた AI 方針 | AI への貼り付け先の注意、提案の承認制 | 使ってよい AI・入力してよい情報の社内ルール |
| 健全なデータ基盤 | WBS の列定義・入力規則・テンプレート | WBS の記入ルール（担当・ID・期限の書き方） |
| AI が使える社内データ | 相談時にタスク・期限・チームWBSの変更を自動で添付 | 社内規程・設計書を AI に参照させる仕組み（開発では AGENTS.md） |
| 確かなバージョン管理 | 同期ログ・変更の通知 | WBS ファイルの版管理（SharePoint の版履歴など） |
| 小さな単位で進める | 所要日数の逆算、タスク分解、容量内の「今日やる」 | 開発では小さな PR の徹底 |
| 利用者中心 | — | 誰のための仕事かを WBS の大分類・中分類で明確にする |
| 質の高い社内プラットフォーム | — | 段階2〜3（GitHub・Graph API 連携） |

---

## 7. 出典

一次情報（公式）:
- Google Cloud: [2025 DORA State of AI-assisted Software Development（PDF）](https://services.google.com/fh/files/misc/2025_state_of_ai_assisted_software_development.pdf)
- Google Cloud Blog: [Introducing DORA's inaugural AI Capabilities Model](https://cloud.google.com/blog/products/ai-machine-learning/introducing-doras-inaugural-ai-capabilities-model)
- Google Research: [Introducing the DORA AI Capabilities Model: 7 keys to succeeding in AI-assisted software development](https://research.google/pubs/introducing-the-dora-ai-capabilities-model-7-keys-to-succeeding-in-ai-assisted-software-development/)
- GitHub: [Spec Kit](https://github.github.com/spec-kit/)
- GitHub Changelog: [Assign issues to Copilot coding agent from Raycast（2026-02-17）](https://github.blog/changelog/2026-02-17-assign-issues-to-copilot-coding-agent-from-raycast/)
- AWS: [AI-Driven Development Life Cycle（AWS 技術ブログ・韓国語）](https://aws.amazon.com/ko/blogs/tech/ai-driven-development-life-cycle/)、[aidlc-workflows 用語集](https://awslabs.github.io/aidlc-workflows/guide/glossary/)
- OpenAI: [Agentic AI Foundation（AGENTS.md の寄贈）](https://openai.com/index/agentic-ai-foundation/)
- METR: [Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)
- Gartner: [Gartner Predicts Over 40% of Agentic AI Projects Will Be Canceled by End of 2027（2025-06-25）](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)
- Microsoft 365 Message Center: [MC1250279 Planner Agent rename and rollout](https://mc.merill.net/message/MC1250279)

二次情報（解説・報道）:
- Splunk: [State of DevOps 2025: Review of the DORA Report](https://www.splunk.com/en_us/blog/learn/state-of-devops)
- Thoughtworks: [The 2025 DORA Report](https://www.thoughtworks.com/en-ca/insights/reports/the-2025-dora-report)
- Visual Studio Magazine: [GitHub Open Sources Kit for Spec Driven AI Development](https://visualstudiomagazine.com/articles/2025/09/03/github-open-sources-kit-for-spec-driven-ai-development.aspx)
- DEV Community: [AWS AI-DLC: Rethinking the SDLC in the Age of AI](https://dev.to/lilupa/aws-ai-dlc-rethinking-the-sdlc-in-the-age-of-ai-4hln)
- Zenn: [Kiro で AWS AI-DLC を実装する記事（implementing-aws-ai-dlc-with-kiro）](https://zenn.dev/st_little/articles/implementing-aws-ai-dlc-with-kiro)
- devclass: [Hands on with Kiro](https://devclass.com/2025/07/15/hands-on-with-kiro-the-aws-preview-of-an-agentic-ai-ide-driven-by-specifications/)
- CodeMySpec: [Kiro Specs Explained: EARS, Spec Mode, and the Trade-offs](https://codemyspec.com/blog/kiro-specs-explained)（自社製品との比較記事のため批評は割り引いて読むこと）
- noqta: [GitHub Agent HQ の解説記事](https://www.noqta.tn/en/blog/github-agent-hq-multi-ai-coding-2026)
- BuzzClan: [Atlassian Rovo Explained](https://buzzclan.com/ai/atlassian-rovo/)
- Office 365 for IT Pros: [Planner Agent Delivers AI Help for Tasks](https://office365itpros.com/2026/03/19/planner-agent/)
- Irish Tech News: [PMI survey reveals 83% of project managers say AI lacks governance](https://irishtechnews.ie/pmi-reveals-83-percent-of-project-managers/amp/)（PMI アイルランド支部、2024年、122人）
- Clarkston Consulting: [2026 Program and Project Management Trends（PDF）](https://clarkstonconsulting.com/wp-content/uploads/2026/03/2026-Program-and-Project-Management-Trends.pdf)
