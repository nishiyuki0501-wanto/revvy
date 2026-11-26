import { DurableObject } from "cloudflare:workers";
import { renderContact, renderMessagePage, renderTerms, renderViewer, type Lang } from "./viewer";

/**
 * Revvy の共有リンク。
 *
 * - POST   /api/v1/shots?retention=30d|forever  画像（JPEG / PNG の生バイト）を受けて URL を返す
 * - DELETE /api/v1/shots/:id                    上げた端末だけが消せる
 * - GET    /:id                                 閲覧ページ（OGP つき、検索除外）
 * - GET    /i/:id                               画像そのもの
 * - POST   /:id/report                          通報（R2 の reports/ に残す）
 *
 * ログインはしない。アプリが初回に作る端末キー（32 バイトの乱数）を Bearer で送り、
 * サーバーはその SHA-256 だけを画像のメタデータに持つ（キーそのものは保存しない）。
 *
 * キーは誰でも作れるので、悪用で保存料が膨らまないよう、回数制限（毎分）に加えて
 * 1 日あたりの上限（端末キーごと・IP ごと・サーバー全体）を Durable Object で数える。
 */

export const RETENTIONS = {
  "30d": { prefix: "t30/", days: 30 },
  forever: { prefix: "keep/", days: null },
} as const;
export type Retention = keyof typeof RETENTIONS;

/** 16 バイトの乱数を base64url にした 22 文字。推測では当たらない長さにする。 */
export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** 端末キー（32 バイトの base64url、43 文字） */
export const DEVICE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const DAY_MS = 86_400_000;
/** 通報フォームの本文の上限 */
const MAX_REPORT_BYTES = 16_384;

type StoredShot = { key: string; object: R2Object; owner: string; expiresAt: number | null };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ message: "unhandled", error: String(error) }));
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const lang = preferredLanguage(request);

  if (path === "/api/v1/shots") {
    if (method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    return upload(request, env, url);
  }
  const apiMatch = path.match(/^\/api\/v1\/shots\/([^/]+)$/);
  if (apiMatch) {
    if (method !== "DELETE") return json({ error: "method_not_allowed" }, 405, { Allow: "DELETE" });
    const { success } = await env.VIEW_IP_LIMIT.limit({ key: clientIP(request) });
    if (!success) return tooManyRequests();
    return remove(request, env, apiMatch[1]);
  }
  if (path === "/robots.txt") return text("User-agent: *\nDisallow: /\n");
  if (path === "/terms") return html(renderTerms(lang));
  if (path === "/contact") {
    if (method === "GET" || method === "HEAD") return html(renderContact(lang));
    if (method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD, POST" });
    return contact(request, env, lang);
  }
  if (path === "/") {
    return html(renderMessagePage(lang, lang === "ja" ? "Revvy の共有リンク" : "Revvy share links",
      lang === "ja" ? "Revvy（Mac のスクリーンショットアプリ）で作られた共有リンクを表示するサーバーです。" : "This server shows links shared from Revvy, a screenshot app for Mac."));
  }

  const imageMatch = path.match(/^\/i\/([^/]+)$/);
  const reportMatch = path.match(/^\/([^/]+)\/report$/);
  const viewMatch = path.match(/^\/([^/]+)$/);
  const id = imageMatch?.[1] ?? reportMatch?.[1] ?? viewMatch?.[1];
  if (!id) return notFound(lang);

  if (reportMatch) {
    if (method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    return report(request, env, id, lang);
  }
  if (method !== "GET" && method !== "HEAD") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });

  const { success } = await env.VIEW_IP_LIMIT.limit({ key: clientIP(request) });
  if (!success) return tooManyRequests();

  if (imageMatch) {
    const shot = await findShot(env, ctx, id, true);
    if (!shot || !("body" in shot.object)) return notFound(lang);
    const object = shot.object as R2ObjectBody;
    return new Response(method === "HEAD" ? null : object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "Content-Length": String(object.size),
        // 削除や期限切れをすぐ反映したいので長くは持たせない（1 分）
        "Cache-Control": "public, max-age=60",
        ETag: object.httpEtag,
        ...privateHeaders(),
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }

  const shot = await findShot(env, ctx, id, false);
  if (!shot) return notFound(lang);
  const origin = url.origin;
  return html(renderViewer({
    lang,
    id,
    imageURL: `${origin}/i/${id}`,
    pageURL: `${origin}/${id}`,
    reportURL: `${origin}/${id}/report`,
    expiresAt: shot.expiresAt,
  }), 200, { "Cache-Control": "no-store" });
}

// MARK: - アップロード

async function upload(request: Request, env: Env, url: URL): Promise<Response> {
  const owner = await authenticate(request);
  if (!owner) return json({ error: "unauthorized" }, 401);

  const retentionParam = url.searchParams.get("retention") ?? "30d";
  // `in` だと "toString" などの継承したプロパティも通ってしまうので、自前のキーだけを認める
  if (!Object.hasOwn(RETENTIONS, retentionParam)) return json({ error: "invalid_retention" }, 400);
  const retention = RETENTIONS[retentionParam as Retention];

  const [byKey, byIP] = await Promise.all([
    env.UPLOAD_KEY_LIMIT.limit({ key: owner }),
    env.UPLOAD_IP_LIMIT.limit({ key: clientIP(request) }),
  ]);
  if (!byKey.success || !byIP.success) return tooManyRequests();

  const maxBytes = Number(env.MAX_UPLOAD_BYTES) || 10_000_000;
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) return json({ error: "too_large", maxBytes }, 413);
  // Content-Length が無い（chunked）送り方でも、上限を超えた時点で読むのをやめる
  const bytes = await readBounded(request, maxBytes);
  if (bytes === null) return json({ error: "too_large", maxBytes }, 413);
  if (bytes.byteLength === 0) return json({ error: "empty_body" }, 400);

  // 申告された Content-Type は信じず、中身の先頭で判定する
  const contentType = sniffImageType(bytes);
  if (!contentType) return json({ error: "unsupported_type" }, 415);

  // 1 日あたりの上限。端末キー → IP → サーバー全体の順に数える
  const quota = await consumeDailyQuota(env, owner, clientIP(request), bytes.byteLength);
  if (quota === "personal") return json({ error: "daily_quota" }, 429, { "Retry-After": String(secondsUntilUTCMidnight()) });
  if (quota === "global") return json({ error: "service_busy" }, 503, { "Retry-After": "3600" });

  const id = newShotID();
  const now = Date.now();
  const expiresAt = retention.days === null ? null : now + retention.days * DAY_MS;
  await env.SHOTS.put(retention.prefix + id, bytes, {
    httpMetadata: { contentType },
    customMetadata: {
      owner,
      createdAt: String(now),
      expiresAt: expiresAt === null ? "" : String(expiresAt),
    },
  });

  return json({
    id,
    url: `${url.origin}/${id}`,
    imageURL: `${url.origin}/i/${id}`,
    retention: retentionParam,
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  }, 201);
}

// MARK: - 削除

async function remove(request: Request, env: Env, id: string): Promise<Response> {
  const owner = await authenticate(request);
  if (!owner) return json({ error: "unauthorized" }, 401);
  if (!ID_PATTERN.test(id)) return json({ error: "not_found" }, 404);
  // 期限切れでも本人は消せるよう、期限を見ずに探す
  const shot = await locate(env, id, false);
  if (!shot) return json({ error: "not_found" }, 404);
  if (!timingSafeEqual(shot.owner, owner)) return json({ error: "forbidden" }, 403);
  await env.SHOTS.delete(shot.key);
  return new Response(null, { status: 204 });
}

// MARK: - 通報

async function report(request: Request, env: Env, id: string, lang: Lang): Promise<Response> {
  // 閲覧ページのフォームからだけ受け付ける（ほかのサイトに代わりに送らせない）
  if (!isSameOriginPost(request)) return json({ error: "forbidden" }, 403);
  const { success } = await env.REPORT_IP_LIMIT.limit({ key: clientIP(request) });
  if (!success) return tooManyRequests();
  if (!ID_PATTERN.test(id) || !(await locate(env, id, false))) return notFound(lang);
  let reason = "";
  try {
    const body = await readBounded(request, MAX_REPORT_BYTES);
    if (body === null) return json({ error: "too_large" }, 413);
    const form = await new Response(body, { headers: { "Content-Type": request.headers.get("Content-Type") ?? "" } }).formData();
    reason = String(form.get("reason") ?? "").slice(0, 100);
    const detail = String(form.get("detail") ?? "").slice(0, 1000);
    // 通報の書き込みにも、サーバー全体で 1 日の上限を設ける
    const day = new Date().toISOString().slice(0, 10);
    const counter = env.QUOTA.get(env.QUOTA.idFromName("reports-global"));
    if (!(await counter.consume(day, 0, Number(env.QUOTA_REPORTS_PER_DAY) || 2_000, Number.MAX_SAFE_INTEGER))) {
      return json({ error: "service_busy" }, 503, { "Retry-After": "3600" });
    }
    // IP は残さない（通報者の個人情報を持たない）。同時の通報で上書きしないよう乱数を付ける
    await env.SHOTS.put(`reports/${new Date().toISOString()}-${id}-${newShotID().slice(0, 8)}.json`, JSON.stringify({
      id, reason, detail, reportedAt: new Date().toISOString(),
      country: (request.cf as { country?: string } | undefined)?.country ?? null,
    }), { httpMetadata: { contentType: "application/json" } });
  } catch {
    return json({ error: "invalid_form" }, 400);
  }
  console.log(JSON.stringify({ message: "report", id, reason }));
  return html(renderMessagePage(lang, lang === "ja" ? "報告を受け付けました" : "Report received",
    lang === "ja" ? "ご報告ありがとうございます。内容を確認し、必要に応じて削除します。" : "Thank you. We will review this image and remove it if needed."));
}

// MARK: - 問い合わせ（削除依頼など。公開されない窓口）

async function contact(request: Request, env: Env, lang: Lang): Promise<Response> {
  if (!isSameOriginPost(request)) return json({ error: "forbidden" }, 403);
  const { success } = await env.REPORT_IP_LIMIT.limit({ key: clientIP(request) });
  if (!success) return tooManyRequests();
  try {
    const body = await readBounded(request, MAX_REPORT_BYTES);
    if (body === null) return json({ error: "too_large" }, 413);
    const form = await new Response(body, { headers: { "Content-Type": request.headers.get("Content-Type") ?? "" } }).formData();
    const field = (name: string, max: number) => { const v = form.get(name); return typeof v === "string" ? v.slice(0, max) : ""; };
    const message = field("message", 2000).trim();
    if (!message) return json({ error: "empty_message" }, 400);
    const day = new Date().toISOString().slice(0, 10);
    const counter = env.QUOTA.get(env.QUOTA.idFromName("reports-global"));
    if (!(await counter.consume(day, 0, Number(env.QUOTA_REPORTS_PER_DAY) || 2_000, Number.MAX_SAFE_INTEGER))) {
      return json({ error: "service_busy" }, 503, { "Retry-After": "3600" });
    }
    // IP は残さない。返信先は本人が書いたときだけ持つ
    await env.SHOTS.put(`reports/contact-${new Date().toISOString()}-${newShotID().slice(0, 8)}.json`, JSON.stringify({
      topic: field("topic", 40), link: field("link", 300), message, reply: field("reply", 200),
      receivedAt: new Date().toISOString(),
    }), { httpMetadata: { contentType: "application/json" } });
  } catch {
    return json({ error: "invalid_form" }, 400);
  }
  console.log(JSON.stringify({ message: "contact" }));
  return html(renderMessagePage(lang, lang === "ja" ? "送信しました" : "Sent",
    lang === "ja" ? "お問い合わせを受け付けました。内容を確認して対応します。" : "We received your message and will review it."));
}

// MARK: - 1 日あたりの上限

type QuotaResult = "ok" | "personal" | "global";

async function consumeDailyQuota(env: Env, owner: string, ip: string, bytes: number): Promise<QuotaResult> {
  const day = new Date().toISOString().slice(0, 10);
  const n = (value: string | undefined, fallback: number) => Number(value) || fallback;
  const scopes: Array<[string, number, number, QuotaResult]> = [
    [`key:${owner}`, n(env.QUOTA_KEY_UPLOADS, 100), n(env.QUOTA_KEY_BYTES, 200_000_000), "personal"],
    // IP は秘密の鍵と日付で HMAC にしてから名前にする（元の IP に戻せず、日をまたいで結び付かない）
    [`ip:${await ipPseudonym(env, ip, day)}`, n(env.QUOTA_IP_UPLOADS, 300), n(env.QUOTA_IP_BYTES, 500_000_000), "personal"],
    ["global", n(env.QUOTA_GLOBAL_UPLOADS, 20_000), n(env.QUOTA_GLOBAL_BYTES, 10_000_000_000), "global"],
  ];
  const consumed: DurableObjectStub<UsageQuota>[] = [];
  for (const [scope, maxCount, maxBytes, failure] of scopes) {
    const counter = env.QUOTA.get(env.QUOTA.idFromName(scope));
    if (!(await counter.consume(day, bytes, maxCount, maxBytes))) {
      // 断ったアップロードは、手前で数えた分を戻す
      await Promise.all(consumed.map((c) => c.refund(day, bytes)));
      return failure;
    }
    consumed.push(counter);
  }
  return "ok";
}

async function ipPseudonym(env: Env, ip: string, day: string): Promise<string> {
  // 本番は wrangler secret put QUOTA_SECRET で入れる。無いとき（手元の開発・テスト）だけ固定値
  const secret = (env as Env & { QUOTA_SECRET?: string }).QUOTA_SECRET || "local-development-only";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${day}|${ip}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function secondsUntilUTCMidnight(now = Date.now()): number {
  return Math.max(60, Math.ceil((DAY_MS - (now % DAY_MS)) / 1000));
}

/**
 * 範囲（端末キー・IP・全体）ごとに 1 つ。1 日の件数とバイト数を SQLite に持つ。
 * 前の日の行はアラームで消し、何も残らなければ保存領域ごと消す（IP 由来の記録を長く持たない）。
 */
export class UsageQuota extends DurableObject<Env> {
  private ensureTable() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, count INTEGER NOT NULL, bytes INTEGER NOT NULL)");
  }

  /** 上限内なら数えて true。超えるなら数えずに false。Durable Object は 1 つずつ処理するので競合しない。 */
  async consume(day: string, bytes: number, maxCount: number, maxBytes: number): Promise<boolean> {
    this.ensureTable();
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM usage WHERE day < ?", day);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    const row = sql.exec<{ count: number; bytes: number }>("SELECT count, bytes FROM usage WHERE day = ?", day).toArray()[0];
    const count = (row?.count ?? 0) + 1;
    const total = (row?.bytes ?? 0) + bytes;
    if (count > maxCount || total > maxBytes) return false;
    sql.exec("INSERT INTO usage (day, count, bytes) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET count = excluded.count, bytes = excluded.bytes", day, count, total);
    return true;
  }

  /** 数えたあとで断ったアップロードの分を戻す */
  async refund(day: string, bytes: number): Promise<void> {
    this.ensureTable();
    this.ctx.storage.sql.exec("UPDATE usage SET count = MAX(count - 1, 0), bytes = MAX(bytes - ?, 0) WHERE day = ?", bytes, day);
  }

  async alarm() {
    this.ensureTable();
    const today = new Date().toISOString().slice(0, 10);
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM usage WHERE day < ?", today);
    const left = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM usage").one().n;
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    else await this.ctx.storage.deleteAll();
  }
}

/** 本文を上限まで読む。超えたら途中で読むのをやめて null。 */
async function readBounded(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

// MARK: - 保存先を探す

/** 保存期間ごとに置き場所（プレフィックス）が違うので、両方を探す。R2 のライフサイクルは prefix 単位で消すため。 */
async function locate(env: Env, id: string, withBody: boolean): Promise<StoredShot | null> {
  for (const { prefix } of Object.values(RETENTIONS)) {
    const key = prefix + id;
    const object = withBody ? await env.SHOTS.get(key) : await env.SHOTS.head(key);
    if (!object) continue;
    const expires = object.customMetadata?.expiresAt;
    return {
      key,
      object,
      owner: object.customMetadata?.owner ?? "",
      expiresAt: expires ? Number(expires) : null,
    };
  }
  return null;
}

/** 閲覧用。R2 のライフサイクル削除はすぐには走らないので、期限はここで必ず確かめる。 */
async function findShot(env: Env, ctx: ExecutionContext, id: string, withBody: boolean): Promise<StoredShot | null> {
  if (!ID_PATTERN.test(id)) return null;
  const shot = await locate(env, id, withBody);
  if (!shot) return null;
  if (shot.expiresAt !== null && shot.expiresAt <= Date.now()) {
    ctx.waitUntil(env.SHOTS.delete(shot.key));
    return null;
  }
  return shot;
}

// MARK: - 補助

async function authenticate(request: Request): Promise<string | null> {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  if (!match || !DEVICE_KEY_PATTERN.test(match[1])) return null;
  return sha256Hex(match[1]);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

export function newShotID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * 先頭と末尾の両方で JPEG / PNG かを確かめる。画像の後ろに別のファイルを付け足して置くこと（ファイル置き場としての悪用）を防ぐ。
 * 申告された Content-Type は使わない。
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const n = bytes.length;
  // JPEG: SOI (FF D8 FF) で始まり、EOI (FF D9) で終わる
  if (n >= 6 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9) return "image/jpeg";
  // PNG: シグネチャで始まり、IEND チャンク（長さ 0 + "IEND" + CRC）で終わる
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const iend = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  if (n >= signature.length + iend.length && signature.every((b, i) => bytes[i] === b) && iend.every((b, i) => bytes[n - iend.length + i] === b)) return "image/png";
  return null;
}

/** 回数を数える単位。IPv4 はアドレス、IPv6 は /56 ごと（1 契約で /64 をいくつも使えるため）。 */
export function clientIP(request: Request): string {
  return ipBucket(request.headers.get("CF-Connecting-IP") ?? "unknown");
}

export function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = ip.includes("::") ? 8 - headParts.length - tailParts.length : 0;
  const groups = [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts].map((g) => g.padStart(4, "0"));
  if (groups.length !== 8) return ip;
  return `${groups.slice(0, 3).join(":")}:${groups[3].slice(0, 2)}00::/56`;
}

/**
 * 同じサイトのフォームから送られたか。
 * 今のブラウザは Sec-Fetch-Site を付けるので、あればそれだけで決める（Referrer-Policy によっては Origin が "null" になるため）。
 * 無い古いブラウザだけ Origin で比べる。
 */
export function isSameOriginPost(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

function preferredLanguage(request: Request): Lang {
  const accept = (request.headers.get("Accept-Language") ?? "").toLowerCase();
  return accept.startsWith("ja") ? "ja" : "en";
}

function privateHeaders(): Record<string, string> {
  return {
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    // 共有 ID をほかのサイトへの Referer に出さない。同じサイトの中（通報フォーム）では Origin を正しく送らせる
    "Referrer-Policy": "same-origin",
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...privateHeaders(), ...headers },
  });
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...privateHeaders(),
      ...headers,
    },
  });
}

function text(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function notFound(lang: Lang): Response {
  return html(renderMessagePage(lang, lang === "ja" ? "見つかりません" : "Not found",
    lang === "ja" ? "このリンクは削除されたか、保存期間が過ぎています。" : "This link was deleted or has expired."), 404, { "Cache-Control": "no-store" });
}

function tooManyRequests(): Response {
  return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
}
