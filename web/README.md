# Timeline Visualizer Web

Google マップから書き出した Timeline JSON を、iPhone・Android・PC のブラウザ内で解析し、旅行経路のプレビュー、全経路 PNG、短い動画を作成する静的 PWA です。

## 特徴

- Timeline JSON はサーバーへアップロードせず、端末内で解析
- 現在の配列形式、`semanticSegments`、従来の `timelineObjects` / `locations` に対応
- 月単位で開始・終了期間を選択（年をまたぐ期間にも対応）
- 距離ベースのアニメーション、長距離区間の大円補間、日付変更線対応
- 1080 × 1080 の全経路 PNG
- `MediaRecorder` が利用できるブラウザで動画生成
  - Safari が対応していれば MP4
  - その他の対応ブラウザでは WebM へフォールバック
- ホーム画面へ追加できる PWA
- GitHub Pages へ自動公開

## プライバシー

JSON の読み込みと経路計算はブラウザ内で行われます。Web アプリは Timeline JSON や経路一覧をサーバーへ送信しません。

背景地図は初期状態で無効です。有効にした場合のみ、表示地域の地図タイルを CARTO から取得します。CARTO にはタイル座標と通常のネットワーク情報が伝わりますが、Timeline JSON は送信されません。地図データは OpenStreetMap contributors によるものです。

## iPhone で使う

1. Google マップを開き、プロフィール写真をタップします。
2. **設定 → 個人的なコンテンツ → タイムライン データのエクスポート**を開きます。
3. JSON を「ファイル」アプリへ保存します。
4. Safari で Web 版を開き、JSON を選択します。
5. 期間と動画時間を設定して、プレビュー、画像、または動画を作成します。
6. 完成後に **保存・共有**を押し、共有シートまたはダウンロードを使用します。

動画作成中は Safari を前面に置き、画面をロックしないでください。iOS はバックグラウンドの Web ページを休止することがあります。

## ローカル起動

ビルドは不要です。リポジトリのルートから静的サーバーを起動します。

```bash
python -m http.server 8000 -d web
```

その後、`http://localhost:8000` を開きます。`file://` では Web Worker と Service Worker が制限されるため、HTTP サーバーを使用してください。

## テスト

Node.js 22 以降を推奨します。外部パッケージは不要です。

```bash
npm --prefix web test
```

このコマンドは、すべての JavaScript ファイルの構文検査と、Timeline 解析・期間抽出・距離計算・日付変更線処理のユニットテストを実行します。

## GitHub Pages

`.github/workflows/web-pwa.yml` は Pull Request でテストを実行し、`main` への反映後に `web/` を GitHub Pages へ公開します。初回のみ、リポジトリの **Settings → Pages → Source** で **GitHub Actions** を選ぶ必要がある場合があります。

## 対応ブラウザと制限

- iOS / iPadOS Safari 16.4 以降を推奨
- 最新の Chrome、Edge、Firefox、Android ブラウザ
- 動画コンテナはブラウザ実装に依存し、MP4 または WebM になります
- 非常に大きな JSON は端末の空きメモリに影響されます
- Google Sign-In から Timeline 履歴を直接取得することはできないため、JSON の書き出しは必要です
- 背景地図なしでも経路、画像、動画を作成できます

## ライセンス

元プロジェクトと同じ MIT License の条件に従います。地図を表示した画像と動画には OpenStreetMap contributors と CARTO の帰属表示を描画します。
