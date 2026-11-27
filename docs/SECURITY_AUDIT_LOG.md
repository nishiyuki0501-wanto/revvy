# セキュリティ診断・修正ログ（2026-11-28）

本ドキュメントは、macOS アプリ（`IssueShot/`）、Cloudflare Workers 共有サーバー（`cloud/`）、配布スクリプト（`scripts/`）、およびプライバシー文書に対する脆弱性診断結果と実施した全修正の記録です。

---

## 0.4.1 再検証

下の一覧は初回診断時の記録です。再レビューで V-05、V-07、V-08、V-09、V-11 と D-01 に追加対応が必要と判明しました。0.4.1 では次の変更を加えています。

- V-05：macOS 付属の libcurl でソケットを開く前に接続先アドレスを検査。HTTPS のみ、各転送 25 MiB、リダイレクト最大 3 回。ファイル URL と画像表現は ImageIO で開き、展開前に 6400 万画素の上限を適用。
- V-07 / D-01：Keychain 検索を同期しない項目に限定。旧形式のアクセス属性について4言語の説明を訂正。端末キーを読めない場合は共有を中断し、新しい鍵で上書きしない。
- V-08：起動時に旧履歴ディレクトリと画像・メタデータの権限も更新し、失敗は呼び出し元に返す。
- V-09：認証ヘッダーの値全体をマスクし、Digest 形式を回帰テストに追加。
- V-11：画像別の Durable Object 内で履歴件数の確認と保存を直列化し、残り1枠に対する同時保存をテスト。

## 1. 初回診断時のサマリー

| 項目 | 状態 | 内容 |
| --- | --- | --- |
| Swift 外部依存関係 | 問題なし | サードパーティ SPM / CocoaPods 依存ゼロ |
| Node / Workers 依存関係 (`npm audit`) | 問題なし | 本番 `dependencies` ゼロ、`devDependencies` 230 パッケージで既知脆弱性 0 件 |
| Critical / High 脆弱性 | 0 件 | 検出なし |
| Medium 課題 | 5 件 → **全件修正済み** | V-01 〜 V-05 |
| Low 課題 | 6 件 → **全件修正済み** | V-06 〜 V-11 |
| ドキュメント整合性 | 1 件 → **全件修正済み** | D-01（4 言語の `PRIVACY*.md` 更新） |
| 自動テスト検証 | macOS 117件成功・1件スキップ | Workers 型検査・単体テスト（51 件）、macOS アプリ単体テスト、App Sandbox ビルド検証 |

---

## 2. 修正ログ一覧

### V-01 [Medium]: CSRF 判定 `isSameOriginPost` のフェイルクローズ化
- **対象ファイル**: `cloud/src/index.ts`, `cloud/test/share.test.ts`
- **課題**: `Sec-Fetch-Site` と `Origin` の両ヘッダーが欠落した POST リクエストに対して `!origin` が `true` を返し、フェイルオープンになっていた。
- **修正内容**:
  - `isSameOriginPost()` を `origin !== null && origin === new URL(request.url).origin` に変更し、両ヘッダー欠落時は `403 forbidden` で拒否するよう修正。
  - `cloud/test/share.test.ts` に両ヘッダー欠落時の `403` 拒否テストを追加。

### V-02 [Medium]: パスワード解除 Cookie の `__Host-` 付与と重複シャドーイング対策
- **対象ファイル**: `cloud/src/index.ts`, `cloud/test/share.test.ts`
- **課題**:
  1. `hasAccess()` で同名 Cookie の先頭要素が期限切れ／不正値の場合に即座に `return false` となり、後続の有効な Cookie が無視される（Cookie シャドーイングによるロックアウト）。
  2. Cookie 名に `__Host-` プレフィックスがなく、独自ドメイン運用時にサブドメインからの同名 Cookie 注入（Cookie Tossing）を許す余地があった。
- **修正内容**:
  - HTTPS 通信時は Cookie 名を `__Host-rv_<hash>`（`Secure; Path=/` 強制・`Domain` 属性禁止）に変更（ローカル開発の HTTP 時のみ `rv_<hash>`）。
  - `hasAccess()` で不正・期限切れの同名 Cookie に遭遇した際は `continue` で後続要素を検査するよう修正。
  - `cloud/test/share.test.ts` に `__Host-rv_` 形式の検証および破損 Cookie 先行時の通過テストを追加。

### V-03 [Medium]: 本番環境での `QUOTA_SECRET` 未設定時フォールバック拒否
- **対象ファイル**: `cloud/src/index.ts`, `cloud/test/share.test.ts`
- **課題**: `ipPseudonym()` が本番環境で `QUOTA_SECRET` 未設定時にも公開定数 `LOCAL_SECRET` に無警告でフォールバックし、設定漏れ時に IP 仮名化の逆算防止保証が崩れる恐れがあった。
- **修正内容**:
  - `signingSecret` を `serverSecret(env, request)` に統合し、`localhost` / `127.0.0.1` / `[::1]` 以外で `QUOTA_SECRET` が未設定の場合はアップロード・バージョン保存・パスワード解除のすべてで固定鍵を使用せず `503` を返すよう修正。
  - `cloud/test/share.test.ts` に本番オリジンでの `503` 拒否と `127.0.0.1` での許可を確認するテストを追加。

### V-04 [Medium]: `assetsBranch`・Git API パス検証と Issue 本文・`bash` 手順のインジェクション対策
- **対象ファイル**: `IssueShot/Services/GitHubClient.swift`, `IssueShot/Services/IssueBodyBuilder.swift`, `IssueShot/AppModel.swift`, `IssueShot/Views/SettingsView.swift`, `IssueShotTests/IssueBodyBuilderTests.swift`
- **課題**:
  1. 設定の `assetsBranch` が未検証のまま API パスおよび Issue 本文の `## AIエージェント向けの手順` 内 `bash` コードブロックに展開され、シェルメタ文字・先頭 `-` オプション注入・`..` パス横断の余地があった。
  2. `IssueBodyBuilder.body` のユーザーコメント部がコードフェンスで囲まれておらず、生 Markdown 描画や `~~~` フェンス脱出の余地があった。
- **修正内容**:
  - `GitHubClient.isValidBranchName(_:)`・`splitRepo(_:)`・`isValidRepoFilePath(_:)` を追加し、`send()` でも `URL.append(path:)` によるセグメント単位構築と `.` / `..` 拒否を徹底。
  - `AppModel.assetsBranch` で不正ブランチ名を既定値（`feedback-assets`）へ安全にフォールバックし、`SettingsView` に警告表示を追加。
  - `IssueBodyBuilder` に `shellToken(_:)`・`inlineCode(_:)` を追加し、コメント本文およびエラー詳細を ```` ```text ```` フェンスで囲み、```` ``` ```` と `~~~` の双方を無害化。
  - `IssueBodyBuilderTests.swift` に単体テストを追加。

### V-05 [Medium]: ドラッグ＆ドロップ URL 取得 (`ImageDrop`) の SSRF・メモリ枯渇対策
- **対象ファイル**: `IssueShot/Services/ImageDrop.swift`, `IssueShotTests/CaptureLibraryTests.swift`
- **課題**: ドロップされた URL を `URLSession.shared.data(from:)` で取得していたため、平文 `http://`・ローカル／プライベート IP へのアクセス・リダイレクト追従・無制限メモリ読み込みが可能だった。
- **修正内容**:
  - `ImageDrop.isAllowedRemoteURL(_:)` を実装し、`https` のみ許可かつ `localhost` / `.local` / `.internal` / ループバック・プライベート・リンクローカル・CGNAT・マルチキャスト IPv4/IPv6（IPv4 射影 IPv6 `::ffff:` を含む）・URL 内認証情報をすべて拒否。
  - `ImageDrop.fetchBoundedImageData(from:maxBytes:session:)` を実装し、`ephemeral` セッション（Cookie 無効・15 秒タイムアウト）・リダイレクト先再検証（最大 3 回）・最大 25 MB のストリーム読み込み上限を導入。
  - `CaptureLibraryTests.swift` にプライベート URL・リダイレクト・サイズ超過の単体テストを追加。

### V-06 [Low]: 外部レスポンス由来 URL のスキーム検証と HTTP レスポンス安全化
- **対象ファイル**: `IssueShot/Services/GitHubAuth.swift`, `IssueShot/Services/GitHubClient.swift`, `IssueShot/Models/GitHubModels.swift`, `IssueShot/AppModel.swift`, `IssueShot/Views/ConnectView.swift`, `IssueShot/Views/ReportView.swift`
- **課題**: API レスポンス由来の `verificationUri` や `issue.htmlUrl` にスキーム／ホスト検証がなく、`response as! HTTPURLResponse` の強制キャストや未制限リダイレクト追従があった。
- **修正内容**:
  - `GitHubURLValidator.isTrustedGitHubWebURL(_:)` で `https://github.com` のみを許可し、`NSWorkspace.shared.open` および UI の `Link` 表示前に検証を追加。
  - `GitHubDeviceFlow`（リダイレクト全面拒否）・`GitHubClient`（`https://api.github.com` 以外へのリダイレクト拒否）に `URLSessionTaskDelegate` を設定し、`HTTPURLResponse` の強制キャストと `UploadedScreenshot.rawUrl` の強制アンラップを除去。

### V-07 [Low]: Keychain の端末限定属性 (`ThisDeviceOnly`) とパスワード保存のデバウンス化
- **対象ファイル**: `IssueShot/Services/KeychainStore.swift`, `IssueShot/AppModel.swift`, `IssueShotTests/CaptureLibraryTests.swift`
- **課題**: Keychain 保存時に `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` が指定されておらず、また共有パスワード入力欄の 1 文字ごとに Keychain 更新が走りエラーが無視されていた。
- **修正内容**:
  - `KeychainStore.write(_:)` に `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` を設定（旧ファイルベース Keychain の `errSecParam` フォールバック対応込み）。
  - `AppModel.sharePassword` の書き込みを 350ms デバウンス化し、共有実行時（`shareScreenshot`）に即時フラッシュ＆エラー通知を行うよう修正。
  - `CaptureLibraryTests.swift` に Keychain ラウンドトリップ・上書き更新テストを追加。

### V-08 [Low]: ローカル履歴のパーミッション制限 (`0700`/`0600`) とクリップボード秘匿属性
- **対象ファイル**: `IssueShot/Services/CaptureLibrary.swift`, `IssueShot/Services/KeychainStore.swift`, `IssueShot/AppModel.swift`, `IssueShot/Views/ReportView.swift`, `IssueShotTests/CaptureLibraryTests.swift`
- **課題**: 非サンドボックス版でキャプチャ・OCR テキスト・`#edit=` 合言葉を含むファイルが標準 umask で作成され、またパスワード等のコピー時にクリップボード履歴ツールや Universal Clipboard に平文で残る状態だった。
- **修正内容**:
  - `CaptureLibrary` でディレクトリ作成・更新時に `0o700`、画像・JSON ファイル書き込み時に `0o600` を強制。
  - `SecretPasteboard.copy(_:concealed:)` を実装し、`.currentHostOnly`（Universal Clipboard 抑止）および `org.nspasteboard.ConcealedType` / `org.nspasteboard.TransientType` を付与してパスワード・編集用リンク・デバイスコードをコピーするよう変更。
  - `CaptureLibraryTests.swift` にパーミッション検証とペーストボード属性テストを追加。

### V-09 [Low]: Issue 本文秘匿情報マスキング（`Masking`）のパターン拡充
- **対象ファイル**: `IssueShot/Services/Masking.swift`, `IssueShotTests/IssueBodyBuilderTests.swift`
- **課題**: `ghr_` リフレッシュトークン、JSON 形式の `"Authorization"`、`Basic` / `token` 認証、`Set-Cookie`、`X-Share-Secret` / `X-Edit-Token` / `X-API-Key`、`#edit=` 合言葉、短いペイロードの JWT、URL 内パスワード、汎用クラウド／AI API キー（`AKIA...`, `sk-...`, `xox...`）がマスキング対象外だった。
- **修正内容**:
  - 上記すべてのパターンを `Masking.patterns` に追加し、通常テキストを壊さない順序（URL 認証情報 → ヘッダー → `#edit=` → JWT → 各種トークン → メールアドレス）で処理するよう更新。
  - `IssueBodyBuilderTests.swift` に網羅的なテストケースを追加。

### V-10 [Low]: デプロイ手順書における秘密鍵の一時ファイル作成廃止
- **対象ファイル**: `cloud/README.md`
- **課題**: `QUOTA_SECRET` 生成時に `/tmp/qs` へ書き出しており、コマンド失敗時に秘密鍵が `/tmp` に残留するリスクがあった。
- **修正内容**: 一時ファイルを作らず標準入力パイプで `npx wrangler secret put QUOTA_SECRET` に直接渡すコマンドへ修正。

### V-11 [Low]: IPv4 射影 IPv6 正規化・バージョン上限の競合対策・OAuth 最小権限オプション・スクリプト検証
- **対象ファイル**: `cloud/src/index.ts`, `cloud/src/editor.client.js`, `IssueShot/Services/GitHubAuth.swift`, `IssueShot/Views/SettingsView.swift`, `scripts/dist.sh`, `scripts/appstore.sh`
- **修正内容**:
  - `ipBucket()` で `::ffff:x.x.x.x` を IPv4 アドレスへ正規化。
  - `saveVersion()` で R2 書き込み後にソート順順位を再確認し、同時リクエストでも先着 `MAX_VERSIONS`（50 件）を超過したオブジェクトを即時削除して `409` を返すよう強化。
  - `report()` でも `findShot()` を使用し、期限切れ画像の通報受付を防止。
  - `editor.client.js` のバージョン ID URL 組み立てに `encodeURIComponent` を適用。
  - 設定画面に GitHub OAuth スコープ選択（`repo` / `public_repo`）を追加し、公開リポジトリのみ利用する場合に最小権限を選択可能化。
  - `scripts/dist.sh`・`scripts/appstore.sh` で `TEAM_ID` の 10 桁英数字形式チェックを追加。

### D-01 [Info]: プライバシーポリシー（4 言語）の実装同期
- **対象ファイル**: `PRIVACY.md`, `PRIVACY.ja.md`, `PRIVACY.ko.md`, `PRIVACY.zh-Hans.md`
- **修正内容**:
  - ローカル保存データの表に「編集用リンク・パスワード保護の有無（`Captures`）」および「共有リンクのパスワード（macOS Keychain・この Mac のみ）」を追記。
  - GitHub 連携における `public_repo` スコープ選択機能と、拡充された秘匿情報マスキング対象を反映。
