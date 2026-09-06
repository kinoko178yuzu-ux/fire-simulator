# Fire Simulator Mac版

- アプリ本体: `dist/Fire Simulator.app`
- データ: `~/Library/Application Support/Fire Simulator/fire_simulator.sqlite3`
- 保存方式: SQLite（WAL）
- 世代バックアップ: 値の更新前に最大100世代を同じDB内へ保存
- Web版のFirebase同期: デスクトップ版では自動解除
- CSV取込通知: 初期値は毎月5日9時。アプリ上部の「通知設定」で変更可能
- 月次チェック: マネフォ家計簿・資産、SBI、楽天本人・奥様を前月単位で保存

初回移行はWeb版の「バックアップ保存」でJSONを書き出し、Mac版の「バックアップ復元」から読み込む。
以後の保存はWeb画面のlocalStorage更新をMac側が受け取り、SQLiteへ同期する。

ビルド:

```zsh
chmod +x desktop/build.command
desktop/build.command
```

Macへインストール（Spotlightで「Fire Simulator」「資産管理」と検索可能）:

```zsh
chmod +x desktop/install.command
desktop/install.command
```
