# Revvy 共有サーバー（cloud/）

アプリの **リンクを作成してコピー** を受ける Cloudflare Workers です。画像は R2 に置き、閲覧ページもこの Worker が返します。GitHub は使いません。

## 構成

| 部品 | 役割 |
| --- | --- |
| Workers（`src/index.ts`） | アップロード・削除の API、閲覧ページ（OGP・noindex。見た目は `src/viewer.ts`、スクリプトは使わない）、画像の配信、通報フォーム |
| R2 バケット `revvy-shots` | 画像（`t1/<id>` は 1 日、`t7/<id>` は 7 日、`t30/<id>` は 30 日、`keep/<id>` は無期限）と通報（`reports/`） |
| R2 のライフサイクル規則 | `t1/` を 1 日、`t7/` を 7 日、`t30/` を 30 日で、`reports/` を 365 日で消す。期限の判定自体は Worker が閲覧のたびに行う（規則による削除は即時ではないため） |
| Rate Limiting | 端末キーごと・IP ごとのアップロード、IP ごとの閲覧・削除・通報の回数制限（毎分） |
| Durable Objects `UsageQuota` | 1 日あたりの上限（端末キーごと・IP ごと・サーバー全体、通報の全体数）。保存料の歯止め |

D1 や KV は使いません。持ち主（端末キーの SHA-256）と期限は R2 のカスタムメタデータに置いています。

### セキュリティ上の決まりごと

- 端末キー：アプリは Keychain の親鍵をそのまま送らず、サーバーの URL ごとに HMAC で作った鍵を送ります。サーバーはそのハッシュだけを持ちます。
- 画像は先頭と末尾（JPEG の EOI、PNG の IEND）で形式を確かめ、後ろに別のデータが付いたものは拒否します。返すときは Content-Type を固定し、`nosniff` と `sandbox` 付きの CSP を付けます。
- 本文は上限まで読んだところで打ち切ります（Content-Length が無い送り方でも）。
- 回数を数える IP は、IPv6 なら /56 ごとにまとめます。1 日の上限では IP を `QUOTA_SECRET` と日付で HMAC にしてから使い、件数は 2 日ほどで消えます。
- 通報フォームは同じオリジンからの送信だけを受け付けます（`Sec-Fetch-Site`／`Origin`）。
- パスワード付きのリンク：アプリが `X-Share-Secret`（UTF-8 の base64url、8〜128 文字。`wrangler tail` で値が伏せ字になるヘッダー名）を付けて上げると、サーバーはソルト付きの PBKDF2（SHA-256、10 万回）のハッシュだけをメタデータに置きます。パスワードを通すまで、閲覧ページ・画像・バージョンは 401 で、OGP の画像も出しません。通したブラウザには、リンクごとの Cookie（期限と HMAC 署名、HttpOnly・Secure・SameSite=Lax、12 時間）を返します。間違いは IP ごとに毎分 10 回、リンクと IP の組ごとに 1 日 20 回、リンクごとに 1 日 300 回までです。
- ブラウザでの書き込み（バージョン）：保存できるのは編集用リンク（`…/<id>#edit=<合言葉>`）を持つ人だけです。合言葉はアップロードのたびにサーバーが作り、ハッシュだけを持ちます（`#` 以降はサーバーにも Referer にも送られず、エディタが `X-Edit-Token` で送ります）。編集用リンクの無い古いリンクは保存できません。元の画像と前のバージョンは書き換えず、1 枚あたり 50 バージョンまで足せます。受け取るのは図形と文字の JSON だけで、知っている形に作り直してから保存します（画像は受け取りません）。保存は閲覧ページからの送信だけを受け付け、IP は保存しません。閲覧ページのスクリプトは自分のサーバーの `/editor.js` だけを許し、保存された文字は HTML として解釈させません。
- バージョンは `t30/<id>.v/<時刻>-<乱数>.json`（無期限は `keep/…`）に置きます。画像を消すと一緒に消えます。
- CORS ヘッダーは返しません。ブラウザからほかのサイトが API を呼ぶことはできません。

### 1 日あたりの上限（`wrangler.jsonc` の `vars`）

| 範囲 | 枚数 | 容量 |
| --- | --- | --- |
| 端末キーごと | 100 | 200MB |
| IP ごと（IPv6 は /56） | 300 | 500MB |
| サーバー全体 | 20,000 | 10GB（超えると全員が 503。保存料の歯止め） |
| 通報（サーバー全体） | 2,000 | — |
| 書き込みの保存（IP ごと） | 300 | — |
| 書き込みの保存（サーバー全体） | 20,000 | — |

1 枚の上限は 5MB です。

### API

| メソッド | パス | 内容 |
| --- | --- | --- |
| `POST` | `/api/v1/shots?retention=30d\|forever&id=long` | 本文は JPEG／PNG の生バイト（上限 5MB、中身の先頭と末尾で形式を判定）。`Authorization: Bearer <端末キー>`。`retention` は `1d`／`7d`／`30d`／`forever`。`X-Share-Secret` を付けるとパスワード付き。`201` で `{id, url, imageURL, editURL, protected, retention, expiresAt}` |
| `DELETE` | `/api/v1/shots/:id` | 作った端末キーのときだけ `204`。ほかのキーは `403`、無いものは `404` |
| `GET` | `/:id` | 閲覧ページ |
| `GET` | `/i/:id` | 画像 |
| `POST` | `/:id/unlock` | パスワード付きリンクのパスワード入力（フォーム）。合っていれば Cookie を返して `/:id` へ |
| `POST` | `/:id/report` | 通報（理由・補足を `reports/` に保存。IP は保存しない） |
| `GET` | `/api/v1/shots/:id/versions` | ブラウザで足した書き込みのバージョン一覧（古い順）。`{versions: [{v, createdAt, label}]}` |
| `POST` | `/api/v1/shots/:id/versions` | 書き込みを新しいバージョンとして保存。本文は JSON（`{width, height, items, label}`、上限 64KB）。閲覧ページからの送信だけを受け付け、`X-Edit-Token`（編集用リンクの合言葉）が要る |
| `GET` | `/api/v1/shots/:id/versions/:v` | バージョンの中身 |
| `GET` | `/editor.js` | 閲覧ページの編集機能（`src/editor.client.js`） |
| `GET` | `/terms` | 利用規約（文面は `src/viewer.ts`。フォークするときは自分の運営に合わせて書き換える） |
| `GET`／`POST` | `/contact` | 非公開の問い合わせフォーム（削除依頼など）。`reports/contact-…json` に保存 |

ID は 32 バイトの乱数を base64url にした 43 文字です（`id=long` を付けたとき。付けない 0.3.0 のアプリには 16 バイト・22 文字を返し、どちらの長さのリンクも開けます）。端末キーは 32 バイトの乱数（43 文字）です。

## 料金の目安

[Workers](https://developers.cloudflare.com/workers/platform/pricing/) と [R2](https://developers.cloudflare.com/r2/pricing/) の公開価格（2026 年 11 月時点）:

- Workers Paid プラン: 月 5 ドル（月 1,000 万リクエストまで込み）。無料プランは 1 日 10 万リクエストまで。ただし Rate Limiting が無料プランで使えるかは確認できていないため、本番は Paid プランを前提にしています
- R2: 保存 0.015 ドル／GB・月（10GB まで無料）、書き込み 4.50 ドル／100 万回（100 万回まで無料）、読み出し 0.36 ドル／100 万回（1,000 万回まで無料）、**転送量は無料**

1 枚を約 0.3MB とすると:

| 保存している枚数 | 保存容量 | R2 の月額 |
| --- | --- | --- |
| 1 万枚 | 3GB | 0 ドル（無料枠内） |
| 10 万枚 | 30GB | 約 0.3 ドル |
| 100 万枚 | 300GB | 約 4.4 ドル |

30 日のリンクは自動で消えるので保存容量は頭打ちになりますが、無期限のリンクは増え続けます。

## 初めてデプロイする

```bash
cd cloud
npm install
npx wrangler login                     # 未ログインのとき
npx wrangler r2 bucket create revvy-shots
npx wrangler r2 bucket lifecycle add revvy-shots expire-30d t30/ --expire-days 30 --force
npx wrangler r2 bucket lifecycle add revvy-shots expire-7d t7/ --expire-days 7 --force
npx wrangler r2 bucket lifecycle add revvy-shots expire-1d t1/ --expire-days 1 --force
npx wrangler r2 bucket lifecycle add revvy-shots expire-reports reports/ --expire-days 365 --force
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put QUOTA_SECRET
npx wrangler deploy
```

表示された URL（例: `https://revvy-share.<サブドメイン>.workers.dev`）を `IssueShot/Services/ShareService.swift` の `ShareConfig.bundledBaseURL` に設定してアプリをビルドします。独自ドメインを使う場合は、`wrangler.jsonc` に `routes` を足して、その URL を設定してください。

## 運用

- **通報・問い合わせの確認**: ダッシュボードの R2 → `revvy-shots` → `reports/` を見ます（問い合わせは `contact-` で始まります）。通知は来ないので、定期的に見てください。`wrangler tail` を動かしておくと、届いた通報がログに出ます。
- **画像の削除（テイクダウン）**: `npx wrangler r2 object delete revvy-shots/t30/<id> --remote`（無期限は `keep/<id>`、7 日は `t7/<id>`、1 日は `t1/<id>`）。画像を消すと、書き込みのバージョンも開けなくなります（バージョンのファイル `t30/<id>.v/` は、30 日の規則で消えます。無期限のものは、ダッシュボードで `keep/<id>.v/` を消してください）。特定のバージョンだけを消すときは、そのファイル（`…/<id>.v/<v>.json`）を消します。閲覧ページと画像はすぐに 404 になります（画像はブラウザなどに最大 1 分キャッシュされることがあります。Slack などのプレビューは各サービス側に残る場合があります）。
- **ログ**: プライバシーポリシーのとおり IP アドレスを残さないため、`observability` は無効にしています。調べるときは `npx wrangler tail` でその場だけ見てください。
- **悪用されたとき**: 1 日の上限は `wrangler.jsonc` の `vars` で変えられます（変えたら `npx wrangler deploy`）。サーバー全体の上限に達すると、その日は全員が共有できなくなります。続くようなら独自ドメインにして、Cloudflare の WAF のレート制限も使ってください。
- **料金の歯止め**: R2 には支払いの上限がないので、ダッシュボードの Billing で利用額の通知を設定してください。

## 開発

```bash
npm test          # Workers ランタイム上のテスト（vitest）
npm run typecheck
npm run dev       # http://127.0.0.1:8787 で起動
BASE=http://127.0.0.1:8787 npm run smoke   # 起動中のサーバーにアップロード→閲覧→削除を通す
```

アプリから手元のサーバーを試すときは、設定の **リンク共有** に `http://127.0.0.1:8787` を入れます（http は localhost だけ許可しています）。アプリのテストから実際に投げる場合は `TEST_RUNNER_REVVY_SHARE_TEST_URL=http://127.0.0.1:8787 make test` を使います。
