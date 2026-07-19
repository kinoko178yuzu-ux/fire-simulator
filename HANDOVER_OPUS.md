# HANDOVER — Opus向け作業指示書（2026-07-19 Fable5作成）

> **これは何**: FIREシミュレーター（このリポジトリ）の未完了修正の完全な作業指示。
> Fable5が方針を決定済み。Opusはこの順に実装すること。**推測で設計を変えない**。

## 0. プロジェクトの前提（毎回これに従う）

- 本体は `index.html` 1ファイル（約6,800行）。ユーザースクリプトは `*.user.js`。
- **修正フロー**: `cp index.html "index.html.bak_$(date +%H%M%S)"` → 編集 → 構文チェック（python括弧バランス）→ ブラウザ検証 → `git add/commit/push origin main`（→GitHub Pagesに自動デプロイ、1〜3分）→ bakファイル削除。
- **検証方法**: `/Users/kinok/Desktop/sakura_beat_drive/.claude/launch.json` に port7800・`--directory /Users/kinok/Desktop/fire-simulator` の設定を書いて preview_start（検証後にlaunch.jsonは削除）。ユーザーの実データは**ユーザーのChromeのgithub.ioオリジン**にあり、claude-in-chrome MCPで直接確認できる。
- **禁止**: body への CSS zoom（Chart.jsのcanvasが無限拡大するバグを起こした実績あり）。localStorageをアプリ関数を通さず直接書き換えない（保存はsaveDataSilent/セッター経由）。
- デプロイ確認: `curl https://kinoko178yuzu-ux.github.io/fire-simulator/ | grep <新コードの目印>` をuntilループで。
- コミットは日本語・`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`（Opus作業時はOpus名義でよい）。

## 1.【最優先】基本入力の再リセット問題（データ消失・2回目）

**症状**: 7/18夜にFable5が復元した基本入力（年齢39/妻38/子8・5、年収606、資産、FIRE目標42/47/52、特別費3件、バケット29件）が、7/19朝に再び初期値へ戻った。ポートフォリオ(77銘柄)・配当実績・資産推移記録は生きている。

**調査手順**:
1. ユーザーのChrome（claude-in-chrome）でgithub.ioを開き `localStorage.getItem('fireSync_passphrase')` を確認。設定されていれば**クラウド同期が原因の可能性大**：空データの端末が接続→クラウドに空を書き込み→github.io側が空をpullして上書き、というシーケンス。
2. `sfs_autobk`（日次自動バックアップ、7/18実装）に良い状態のスナップショットがあるか確認。あれば `restoreAutoBackup()` 相当で復元（ただし復元前に現在のportfolio/accountHistory/divActualを退避しマージすること。バックアップが古いとそれらが消える）。
3. index.htmlの同期コード（`fireSync` / `applyCloud` / `saveCloud` 周辺、4500行付近）を読み、**接続時の初回動作**を確認。

**恒久修正（必須）**: 同期の初回接続時ガードを実装する。
- 接続時: ローカルとクラウド両方に実データがある→どちらを採用するかconfirmで選択させる。ローカルに実データ・クラウドが空→**push（ローカル→クラウド）**。ローカル空・クラウドに実データ→pull。
- 「実データがある」判定は 例: budgetSheetJsonに年キーがある or divPortfolioJsonが非空 or currentAgeが初期値40以外。

**復元データ（アプリの関数経由でユーザーのChromeに投入する。前回スクリプトはgit log d9c2cd4直後の会話参照。値一覧）**:
- currentAge 39 / spouseAge 38 / child1Age 8 / child2Age 5 / currentSalary 606
- assetCash 439 / assetIndex 2792 / assetDividend 1935（7/18マネフォ実測）
- sideIncomeGross 180 / monthlyLifeExHouse 19 / loanBalance 1770
- fireAge1 42 / fireAge2 47 / fireAge3 52
- spotEventsJson: 車更新(car,expense,year,2035,300万,repeat7) / トラクター(other,expense,year,2035,600万,repeat15) / 住宅修繕(house,expense,year,2037,200万,repeat10)
- bucketListJson: マインドマップ29項目（index.htmlの旧DEFAULT_BUCKET_ITEMS、git履歴 `git show 44ee9eb:index.html` 内 DEFAULT_BUCKET_ITEMS が29項目版）
- **注意**: 現在ある portfolio(77銘柄)・divActualJson(配当実績)・accountHistoryJson(2026-07記録)・budgetSheetJson(MF取込分) は**上書きしない**（inputだけ設定）。
- 復元後 saveDataSilent() を呼び、☁️同期の合言葉設定をユーザーに依頼（安全化実装後に）。

## 2. SBI自動取得が無反応（原因特定済み）

**原因**: SBIログイン後は `site2.sbisec.co.jp`（旧メインサイト）に遷移するが、`broker_fire_bridge.user.js` の @match は `site.sbisec.co.jp` のみ。スクリプトが注入されず何も起きない。

**修正**（broker_fire_bridge.user.js v1.4）:
1. `// @match https://site2.sbisec.co.jp/*` を追加。
2. SBI側ロジック: `location.hostname` が site2 の場合、sbiReq が有効なら配当ページ `https://site.sbisec.co.jp/account/assets/dividends?dispositionDateFrom=...&dispositionDateTo=...` へ `location.href` で遷移（site→site2間はセッション共有されている。遷移後は既存ロジックが動く）。isSBI判定を `/sbisec\.co\.jp$/.test(hostname)` 系に緩める。
3. バージョンを1.4に上げ、**ユーザーに再インストールを依頼**（アプリからのリンク: `${location.origin}/broker_fire_bridge.user.js`）。
4. 実機テストはユーザーに依頼（SBIの配当ページDOMは未検証。CSVボタン検出は既存 findCsvBtn / 「受取額」待ち）。

## 3. 口座（名義）セレクトの廃止 → ボタン押下時に選択

**症状/要望**: セレクトを変えても何も起きず「意味がない」。ファイル取込は既にファイルごとのモーダルで名義を選ぶ。

**修正**（index.html）:
- `divBrokerLabel` セレクトと「口座（名義）」ラベルをHTMLから削除。
- `brokerFetch('rakuten')`: セレクト参照をやめ、`confirm`ではなく小さな選択（既存の取込モーダルと同様のオーバーレイ、または `prompt` より良い2ボタンダイアログ）で「私／妻」を選ばせ `_brokerFetchLabels.rakuten` に設定。SBIは従来どおり「私」固定。
- `_brokerImport` のフォールバック `document.getElementById('divBrokerLabel')` 参照を削除。

## 4. 「配当を年間収支シートに反映」の自動化

**要望**: 取込した時点で自動反映してよい。
**修正**: `importBrokerCSV` 成功後（ファイルモーダル取込完了時と自動取得の `_brokerImport` 内）に `applyBrokerToBudget()` を自動実行。ボタンは残すが「🔁 再反映」的な小さめ表示に降格（文言: 自動で反映済み。手動でやり直す場合のみ）。結果表示（◯ヶ月分反映）は既存のdivToBudgetStatusに出る。

## 5. 全銘柄テーブルの改善（配当管理・renderHighDiv内 allRows）

1. **購入額列を追加**: 取得単価の隣に `購入額`（`r.purchase`、円）列。ヘッダ・td両方（列数ズレに注意。現在th16列）。
2. **配当割合列を追加**: `配当割合` ＝ `dispVal(r)/Σdi​spVal×100`（表示設定の税引前後に追随）。シートの「割合(10.21%)」に相当。10%以上は黄色ハイライト（シート準拠: `background:#ffef9c` 程度）。
3. **業種セルに業種割合を併記**: `${r.sector} <span style="color:var(--ink-mute)">(11.5%)</span>` 形式（secPct を利用。renderHighDiv内で計算済みの secPct を allRows 生成より前に移動する必要あり→現在 buySection 用に allRows より後で計算しているので順序を入れ替える）。
4. **ゼブラ縞**: CSS `.bg-table tbody tr:nth-child(even) td { background: rgba(0,0,0,0.025); }` を追加。既存の hover 色・bg-cell の背景と競合しないこと（bg-cell入力セルは収支シート側なので影響確認。収支シートも同ルール適用で見やすくなるなら可）。

## 6. 既存タスク（タスクリスト #1〜#3）

- **#3 売却銘柄の検出＋削除ボタン**（小・先にやる）: refreshFromMF / refreshFromStructured 実行時、取込に含まれない既存銘柄を検出→結果メッセージに「🗑 売却済み？ <code> <name> [削除] [残す]」UI。✏️銘柄の編集の各行に×ボタン（confirm付き、`delete p[code]`）。
- **#1 重複UIの整理**（中）: (a)「📅 配当 予定 vs 実績」カード(dividendCard)と高配当株管理内「銘柄別 予定vs実績」(divPerStock)の二重→dividendCardに一本化 or divPerStockをdividendCardへ移動し重複表を削除。(b) 旧・配当リスト系統（dividendListJson / renderDivStocks / divPasteArea / divAddBtn 等の手入力方式）を削除（divPortfolioJsonに一本化）。**削除前に全参照をgrepし、renderDivCompareがpfRowsベースであることを確認**。(c)「FIRE後の月額固定費まとめ」と「年齢別 年間収支の構成」の重複整理は表示統合のみ（ロジックは触らない）。
- **#2 取り崩しガードレール**（大・最後）: 「今年使ってよい額」カード。方式: 基本額=FIRE後資産×取り崩し率（coastRateを流用 or 別設定）、ガードレール=前年支出額±10%にクリップ、下限=（年金+副収入の手取り）。KPIバー5枚目は混みすぎるためカード内表示のみ。**実装前にユーザーへ設計1画面（計算式）を提示して承認を得ること**。

## 7. 参考情報

- ユーザーは楽天自動取得（私:17件）に成功済み。妻分は未取得。SBIは§2修正後に。
- 配当→収支反映は7ヶ月分動作確認済み。
- NISA自動判定ボタンは配当CSV再取込後に案内（✏️銘柄の編集内）。
- 直近コミット: a7ea772（自動BK・円グラフ・リマインダー）。
- タスク管理: このファイルとClaude Codeのタスクリストを両方更新すること。
