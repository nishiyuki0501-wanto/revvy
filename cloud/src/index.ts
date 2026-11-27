import { DurableObject } from "cloudflare:workers";
import EDITOR_JS from "./editor.client.js";
import { ICON_PNG_BASE64 } from "./icon";
import { MAX_VERSIONS } from "./limits";
import { renderContact, renderLocked, renderMessagePage, renderTerms, renderViewer, type Lang } from "./viewer";

/**
 * Revvy の共有リンク。
 *
 * - POST   /api/v1/shots?retention=30d|forever&id=long  画像（JPEG / PNG の生バイト）を受けて URL を返す
 * - DELETE /api/v1/shots/:id                    上げた端末だけが消せる
 * - GET    /:id                                 閲覧ページ（OGP つき、検索除外）
 * - GET    /i/:id                               画像そのもの
 * - POST   /:id/report                          通報（R2 の reports/ に残す）
 * - GET    /api/v1/shots/:id/versions           ブラウザで足した書き込みのバージョン一覧
 * - POST   /api/v1/shots/:id/versions           書き込みを新しいバージョンとして保存（閲覧ページからだけ）
 * - GET    /api/v1/shots/:id/versions/:v        バージョンの中身
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
  // 短い期限。置き場所を分けて、R2 のライフサイクル規則（t7/ は 7 日、t1/ は 1 日）でも消す
  "7d": { prefix: "t7/", days: 7 },
  "1d": { prefix: "t1/", days: 1 },
} as const;
export type Retention = keyof typeof RETENTIONS;

/**
 * 乱数を base64url にしたもの。32 バイト（43 文字）が今の形で、16 バイト（22 文字）は 0.3.0 のアプリが作る形。
 * どちらも推測では当たらない長さで、古いリンクも引き続き開ける。
 */
export const ID_PATTERN = /^(?:[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})$/;
/** `?id=` の値と、ID にする乱数のバイト数。0.3.0 のアプリは 22 文字の ID しか受け取らないので、指定がなければ短いほうを返す。 */
const ID_BYTES = { short: 16, long: 32 } as const;
/** 端末キー（32 バイトの base64url、43 文字） */
export const DEVICE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** /editor.js の中身が変わったら URL も変わるようにする（古いスクリプトと新しいページが組み合わさらないように） */
const EDITOR_VERSION = (() => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < EDITOR_JS.length; i += 1) hash = Math.imul(hash ^ EDITOR_JS.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(36);
})();

const editorScript = `/editor.js?v=${EDITOR_VERSION}`;
/**
 * パスワードの入口のページでも /editor.js だけは動かす。編集用リンク（#edit=…）で開いたときに、
 * 合言葉をタブの中に取っておき、パスワードを通したあとも編集できるようにするため。
 */
const lockedCSP = { "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };

/** バージョンの ID。作った時刻（ミリ秒、13 桁）と乱数。名前の順がそのまま作った順になる。 */
export const VERSION_ID_PATTERN = /^[0-9]{13}-[A-Za-z0-9_-]{8}$/;
/** 書き込み 1 バージョンの本文（JSON）の上限 */
const MAX_VERSION_BYTES = 65_536;

const DAY_MS = 86_400_000;
/** 通報フォームの本文の上限 */
const MAX_REPORT_BYTES = 16_384;

/** edit は編集用リンクの合言葉のハッシュ、pw はパスワードのハッシュ（どちらも、無ければ空） */
type StoredShot = { key: string; object: R2Object; owner: string; expiresAt: number | null; edit: string; pw: string };
/** パスワードを通したあとの Cookie の有効時間 */
const UNLOCK_SECONDS = 12 * 3600;
const EDIT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIN_PASSWORD_LENGTH = 8;

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
  const versionsMatch = path.match(/^\/api\/v1\/shots\/([^/]+)\/versions(?:\/([^/]+))?$/);
  if (versionsMatch) return versionsAPI(request, env, ctx, versionsMatch[1], versionsMatch[2]);
  if (path === "/editor.js") {
    return new Response(EDITOR_JS, {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400", ...privateHeaders() },
    });
  }
  const apiMatch = path.match(/^\/api\/v1\/shots\/([^/]+)$/);
  if (apiMatch) {
    if (method !== "DELETE") return json({ error: "method_not_allowed" }, 405, { Allow: "DELETE" });
    const { success } = await env.VIEW_IP_LIMIT.limit({ key: clientIP(request) });
    if (!success) return tooManyRequests();
    return remove(request, env, apiMatch[1]);
  }
  if (path === "/api/v1/capabilities") {
    // アプリが画像を送る前に、このサーバーでパスワード付きのリンクを作れるかを確かめる
    return json({ password: serverSecret(env, request) !== null, minPasswordLength: MIN_PASSWORD_LENGTH, editLinks: true, retentions: Object.keys(RETENTIONS) });
  }
  if (path === "/robots.txt") return text("User-agent: *\nDisallow: /\n");
  if (path === "/icon.png") {
    return new Response(Uint8Array.from(atob(ICON_PNG_BASE64), (c) => c.charCodeAt(0)), {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", ...privateHeaders() },
    });
  }
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
  const unlockMatch = path.match(/^\/([^/]+)\/unlock$/);
  if (unlockMatch) {
    if (method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    return unlock(request, env, ctx, unlockMatch[1], lang);
  }
  const reportMatch = path.match(/^\/([^/]+)\/report$/);
  const viewMatch = path.match(/^\/([^/]+)$/);
  const id = imageMatch?.[1] ?? reportMatch?.[1] ?? viewMatch?.[1];
  if (!id) return notFound(lang);

  if (reportMatch) {
    if (method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    return report(request, env, ctx, id, lang);
  }
  if (method !== "GET" && method !== "HEAD") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });

  const { success } = await env.VIEW_IP_LIMIT.limit({ key: clientIP(request) });
  if (!success) return tooManyRequests();

  if (imageMatch) {
    const shot = await findShot(env, ctx, id, true);
    if (!shot || !("body" in shot.object)) return notFound(lang);
    if (!(await hasAccess(request, env, id, shot))) return json({ error: "locked" }, 401);
    const object = shot.object as R2ObjectBody;
    return new Response(method === "HEAD" ? null : object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "Content-Length": String(object.size),
        // 削除や期限切れをすぐ反映したいので長くは持たせない（1 分）
        // 途中の共有キャッシュには持たせない（private）
        "Cache-Control": shot.pw ? "private, no-store" : "private, max-age=60",
        ETag: object.httpEtag,
        ...privateHeaders(),
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }

  const shot = await findShot(env, ctx, id, false);
  if (!shot) return notFound(lang);
  // パスワード付きのリンクは、通すまで画像の情報を何も出さない（プレビュー用の og:image も出さない）
  if (!(await hasAccess(request, env, id, shot))) return html(renderLocked(lang, id, null, editorScript), 401, { "Cache-Control": "no-store", ...lockedCSP });
  const origin = url.origin;
  return html(renderViewer({
    lang,
    id,
    imageURL: `${origin}/i/${id}`,
    pageURL: `${origin}/${id}`,
    reportURL: `${origin}/${id}/report`,
    scriptURL: editorScript,
    expiresAt: shot.expiresAt,
    createdAt: Number(shot.object.customMetadata?.createdAt) || null,
    size: shot.object.size,
    contentType: shot.object.httpMetadata?.contentType ?? "image/jpeg",
    now: Date.now(),
    locked: shot.pw !== "",
  }), 200, {
    "Cache-Control": "no-store",
    // 閲覧ページだけ、自分のサーバーのスクリプト（/editor.js）と API を許す。インラインのスクリプトは通さない
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
}

// MARK: - アップロード

async function upload(request: Request, env: Env, url: URL): Promise<Response> {
  const owner = await authenticate(request);
  if (!owner) return json({ error: "unauthorized" }, 401);

  const retentionParam = url.searchParams.get("retention") ?? "30d";
  // `in` だと "toString" などの継承したプロパティも通ってしまうので、自前のキーだけを認める
  if (!Object.hasOwn(RETENTIONS, retentionParam)) return json({ error: "invalid_retention" }, 400);
  const retention = RETENTIONS[retentionParam as Retention];
  const idParam = url.searchParams.get("id") ?? "short";
  if (!Object.hasOwn(ID_BYTES, idParam)) return json({ error: "invalid_id_format" }, 400);
  const idBytes = ID_BYTES[idParam as keyof typeof ID_BYTES];
  const password = readPassword(request);
  if (password === null) return json({ error: "invalid_password" }, 400);
  // 秘密鍵（QUOTA_SECRET）が無い本番サーバーでは、IP の仮名化や Cookie 署名を固定値で行わない
  const secret = serverSecret(env, request);
  if (!secret) return json({ error: password ? "password_unavailable" : "server_misconfigured" }, 503);

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
  const quota = await consumeDailyQuota(env, secret, owner, clientIP(request), bytes.byteLength);
  if (quota === "personal") return json({ error: "daily_quota" }, 429, { "Retry-After": String(secondsUntilUTCMidnight()) });
  if (quota === "global") return json({ error: "service_busy" }, 503, { "Retry-After": "3600" });

  const id = newShotID(idBytes);
  // 書き込みを保存できるのは、この合言葉を持つ人だけ。URL の # 以降に入れて返す（# 以降はサーバーにも Referer にも送られない）
  const editToken = newShotID(32);
  const now = Date.now();
  const expiresAt = retention.days === null ? null : now + retention.days * DAY_MS;
  await env.SHOTS.put(retention.prefix + id, bytes, {
    httpMetadata: { contentType },
    customMetadata: {
      owner,
      createdAt: String(now),
      expiresAt: expiresAt === null ? "" : String(expiresAt),
      edit: await sha256Hex(editToken),
      ...(password ? { pw: await hashPassword(password) } : {}),
    },
  });

  return json({
    id,
    url: `${url.origin}/${id}`,
    imageURL: `${url.origin}/i/${id}`,
    editURL: `${url.origin}/${id}#edit=${editToken}`,
    protected: password !== "",
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
  await deleteVersions(env, shot.key);
  return new Response(null, { status: 204 });
}

// MARK: - ブラウザで足した書き込みのバージョン

type Point2 = { x1: number; y1: number; x2: number; y2: number };
export type InkItem =
  | ({ t: "rect" | "ellipse" | "line" | "arrow" | "ruler"; color: string; width: number } & Point2)
  | { t: "pen"; color: string; width: number; points: number[] }
  | { t: "text"; color: string; size: number; x: number; y: number; text: string };
export type VersionInput = { width: number; height: number; label: string; items: InkItem[] };

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const COORD = 100_000;

function bounded(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? Math.round(value * 100) / 100 : null;
}

/** 制御文字を落とす（改行は keepNewlines のときだけ残す） */
function cleanText(value: string, keepNewlines: boolean): string {
  return [...value].filter((c) => {
    const code = c.codePointAt(0)!;
    return (keepNewlines && c === "\n") || (code >= 0x20 && code !== 0x7f);
  }).join("");
}

function parseInkItem(raw: unknown): InkItem | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.color !== "string" || !COLOR_PATTERN.test(o.color)) return null;
  const color = o.color.toLowerCase();
  const t = o.t;
  if (t === "text") {
    const x = bounded(o.x, -COORD, COORD), y = bounded(o.y, -COORD, COORD), size = bounded(o.size, 4, 4000);
    if (x === null || y === null || size === null || typeof o.text !== "string") return null;
    const text = cleanText(o.text, true);
    if (!text.trim() || text.length > 500) return null;
    return { t, color, size, x, y, text };
  }
  const width = bounded(o.width, 0.5, 400);
  if (width === null) return null;
  if (t === "pen") {
    if (!Array.isArray(o.points) || o.points.length < 4 || o.points.length > 4000 || o.points.length % 2 !== 0) return null;
    const points: number[] = [];
    for (const value of o.points) {
      const n = bounded(value, -COORD, COORD);
      if (n === null) return null;
      points.push(n);
    }
    return { t, color, width, points };
  }
  if (t === "rect" || t === "ellipse" || t === "line" || t === "arrow" || t === "ruler") {
    const x1 = bounded(o.x1, -COORD, COORD), y1 = bounded(o.y1, -COORD, COORD), x2 = bounded(o.x2, -COORD, COORD), y2 = bounded(o.y2, -COORD, COORD);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    return { t, color, width, x1, y1, x2, y2 };
  }
  return null;
}

/** 保存する書き込みは、知っている形だけを作り直して持つ（知らないキーや HTML になりうる値は残さない）。 */
export function parseVersion(raw: unknown): VersionInput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const width = bounded(o.width, 1, 30_000), height = bounded(o.height, 1, 30_000);
  if (width === null || height === null || !Array.isArray(o.items) || o.items.length > 300) return null;
  if (o.label !== undefined && typeof o.label !== "string") return null;
  const items: InkItem[] = [];
  for (const entry of o.items) {
    const item = parseInkItem(entry);
    if (!item) return null;
    items.push(item);
  }
  return { width, height, label: cleanText(o.label ?? "", false).trim().slice(0, 60), items };
}

function versionPrefix(shotKey: string): string {
  // ID に "." は入らないので、ほかの画像のキーと重ならない。保存期間のプレフィックスは画像と同じ（30 日の規則がそのまま効く）
  return `${shotKey}.v/`;
}

type VersionSummary = { v: string; createdAt: number; label: string };

async function listVersions(env: Env, shotKey: string): Promise<VersionSummary[]> {
  const prefix = versionPrefix(shotKey);
  const listed = await env.SHOTS.list({ prefix, limit: 1000, include: ["customMetadata"] });
  return listed.objects
    .map((object) => {
      const v = object.key.slice(prefix.length).replace(/\.json$/, "");
      let label = "";
      try { label = decodeURIComponent(object.customMetadata?.label ?? ""); } catch { /* 壊れたラベルは出さない */ }
      return { v, createdAt: Number(v.slice(0, 13)), label };
    })
    .filter((version) => VERSION_ID_PATTERN.test(version.v))
    .sort((a, b) => (a.v < b.v ? -1 : 1));
}

async function deleteVersions(env: Env, shotKey: string): Promise<void> {
  const listed = await env.SHOTS.list({ prefix: versionPrefix(shotKey), limit: 1000 });
  if (listed.objects.length) await env.SHOTS.delete(listed.objects.map((object) => object.key));
}

async function versionsAPI(request: Request, env: Env, ctx: ExecutionContext, id: string, versionID: string | undefined): Promise<Response> {
  const method = request.method;
  if (versionID === undefined && method === "POST") return saveVersion(request, env, ctx, id);
  if (method !== "GET" && method !== "HEAD") {
    return json({ error: "method_not_allowed" }, 405, { Allow: versionID === undefined ? "GET, HEAD, POST" : "GET, HEAD" });
  }
  const { success } = await env.VIEW_IP_LIMIT.limit({ key: clientIP(request) });
  if (!success) return tooManyRequests();
  const shot = await findShot(env, ctx, id, false);
  if (!shot) return json({ error: "not_found" }, 404);
  if (!(await hasAccess(request, env, id, shot))) return json({ error: "locked" }, 401);
  if (versionID === undefined) return json({ versions: await listVersions(env, shot.key) });
  if (!VERSION_ID_PATTERN.test(versionID)) return json({ error: "not_found" }, 404);
  const object = await env.SHOTS.get(`${versionPrefix(shot.key)}${versionID}.json`);
  if (!object) return json({ error: "not_found" }, 404);
  return new Response(method === "HEAD" ? null : object.body, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...privateHeaders() },
  });
}

/**
 * 保存できるのは、編集用リンク（合言葉つき）を持っている人だけ。見るだけのリンクでは保存できない。
 * 元の画像と前のバージョンは書き換えず、必ず新しいバージョンを足す。画像は受け取らない（図形と文字の JSON だけ）。
 */
async function saveVersion(request: Request, env: Env, ctx: ExecutionContext, id: string): Promise<Response> {
  // 閲覧ページからだけ受け付ける（ほかのサイトに代わりに書き込ませない）
  if (!isSameOriginPost(request)) return json({ error: "forbidden" }, 403);
  const ip = clientIP(request);
  const { success } = await env.EDIT_IP_LIMIT.limit({ key: ip });
  if (!success) return tooManyRequests();
  const shot = await findShot(env, ctx, id, false);
  if (!shot) return json({ error: "not_found" }, 404);
  if (!(await hasAccess(request, env, id, shot))) return json({ error: "locked" }, 401);
  const editToken = request.headers.get("X-Edit-Token") ?? "";
  if (!shot.edit || !EDIT_TOKEN_PATTERN.test(editToken) || !timingSafeEqual(await sha256Hex(editToken), shot.edit)) {
    return json({ error: "read_only" }, 403);
  }

  const body = await readBounded(request, MAX_VERSION_BYTES);
  if (body === null) return json({ error: "too_large" }, 413);
  let input: VersionInput | null = null;
  try { input = parseVersion(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body))); } catch { /* JSON でない */ }
  if (!input) return json({ error: "invalid_version" }, 400);

  if ((await listVersions(env, shot.key)).length >= MAX_VERSIONS) return json({ error: "too_many_versions" }, 409);
  const secret = serverSecret(env, request);
  if (!secret) return json({ error: "server_misconfigured" }, 503);

  const day = new Date().toISOString().slice(0, 10);
  const n = (value: string | undefined, fallback: number) => Number(value) || fallback;
  const perIP = env.QUOTA.get(env.QUOTA.idFromName(`edit-ip:${await ipPseudonym(secret, ip, day)}`));
  if (!(await perIP.consume(day, body.byteLength, n(env.QUOTA_IP_EDITS, 300), Number.MAX_SAFE_INTEGER))) {
    return json({ error: "daily_quota" }, 429, { "Retry-After": String(secondsUntilUTCMidnight()) });
  }
  const global = env.QUOTA.get(env.QUOTA.idFromName("edits-global"));
  if (!(await global.consume(day, body.byteLength, n(env.QUOTA_GLOBAL_EDITS, 20_000), Number.MAX_SAFE_INTEGER))) {
    await perIP.refund(day, body.byteLength);
    return json({ error: "service_busy" }, 503, { "Retry-After": "3600" });
  }

  const writer = env.QUOTA.get(env.QUOTA.idFromName(`versions:${shot.key}`));
  const result = await writer.appendVersion(shot.key, input);
  if (result === "full") return json({ error: "too_many_versions" }, 409);
  if (result === "gone") return json({ error: "not_found" }, 404);
  return json(result, 201);
}

// MARK: - パスワード付きのリンク

/**
 * アップロードのときのパスワード（X-Share-Secret に、UTF-8 を base64url にして入れる）。無ければ ""、形が悪ければ null。
 * ヘッダー名に secret を入れているのは、wrangler tail が値を伏せ字にする名前だから（実際に確かめた。X-Share-Password だと値が見えた）。
 */
function readPassword(request: Request): string | null {
  const header = request.headers.get("X-Share-Secret");
  if (header === null || header === "") return "";
  if (!/^[A-Za-z0-9_-]{1,700}$/.test(header)) return null;
  try {
    const bytes = Uint8Array.from(atob(header.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const length = [...value].length;
    if (length < MIN_PASSWORD_LENGTH || length > 128 || cleanText(value, false) !== value) return null;
    return value;
  } catch {
    return null;
  }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64url = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256));
}

/** パスワードそのものは持たない。ソルトと PBKDF2 の結果だけを画像のメタデータに置く。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${b64url(salt)}.${b64url(await pbkdf2(password, salt))}`;
}

export async function verifyPassword(stored: string, candidate: string): Promise<boolean> {
  const [salt, hash] = stored.split(".");
  if (!salt || !hash || candidate.length > 512) return false;
  try {
    return timingSafeEqual(b64url(await pbkdf2(candidate, unb64url(salt))), hash);
  } catch {
    return false;
  }
}

const LOCAL_SECRET = "local-development-only";

/**
 * Cookie の署名と IP の仮名化に使う秘密鍵。本番は wrangler secret put QUOTA_SECRET で入れる。
 * 入れ忘れたサーバーで、誰でも知っている固定値を本番で使ってしまわないよう、固定値は手元（localhost）だけで使う。
 */
function serverSecret(env: Env, request: Request): string | null {
  const secret = (env as Env & { QUOTA_SECRET?: string }).QUOTA_SECRET;
  if (secret) return secret;
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" ? LOCAL_SECRET : null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cookie の名前。リンクごとに別で、名前から ID は分からない。HTTPS では __Host- を付けて別サブドメインからの上書きを防ぐ。 */
async function unlockCookieName(id: string, isHTTPS: boolean): Promise<string> {
  const prefix = isHTTPS ? "__Host-rv_" : "rv_";
  return `${prefix}${(await sha256Hex(`cookie|${id}`)).slice(0, 16)}`;
}

/** パスワードの無いリンクは誰でも。あるリンクは、通したあとの Cookie（期限とサーバーの署名つき）を持つブラウザだけ。 */
async function hasAccess(request: Request, env: Env, id: string, shot: StoredShot): Promise<boolean> {
  if (!shot.pw) return true;
  const secret = serverSecret(env, request);
  if (!secret) return false;
  const name = await unlockCookieName(id, new URL(request.url).protocol === "https:");
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key !== name) continue;
    const [expires, mac = ""] = value.split(".");
    // 同名の古い Cookie が先に並んでいても、後ろの有効な Cookie を見落とさないよう continue する
    if (!/^[0-9]{10,13}$/.test(expires) || Number(expires) <= Date.now()) continue;
    // パスワードを変えた（上げ直した）ら、前の Cookie は通らない
    if (timingSafeEqual(mac, await hmacHex(secret, `unlock|${id}|${shot.pw}|${expires}`))) return true;
  }
  return false;
}

async function unlock(request: Request, env: Env, ctx: ExecutionContext, id: string, lang: Lang): Promise<Response> {
  if (!isSameOriginPost(request)) return json({ error: "forbidden" }, 403);
  const { success } = await env.UNLOCK_IP_LIMIT.limit({ key: clientIP(request) });
  if (!success) return html(renderLocked(lang, id, "busy", editorScript), 429, { "Cache-Control": "no-store", "Retry-After": "60", ...lockedCSP });
  const shot = await findShot(env, ctx, id, false);
  if (!shot) return notFound(lang);
  const seeOther = (extra: Record<string, string> = {}) =>
    new Response(null, { status: 303, headers: { Location: `/${id}`, "Cache-Control": "no-store", ...privateHeaders(), ...extra } });
  if (!shot.pw) return seeOther();
  const secret = serverSecret(env, request);
  if (!secret) return json({ error: "password_unavailable" }, 503);
  let candidate = "";
  try {
    const body = await readBounded(request, 4096);
    if (body === null) return json({ error: "too_large" }, 413);
    const form = await new Response(body, { headers: { "Content-Type": request.headers.get("Content-Type") ?? "" } }).formData();
    const value = form.get("password");
    candidate = typeof value === "string" ? value : "";
  } catch {
    return json({ error: "invalid_form" }, 400);
  }
  // 総当たりを止める。1 日に間違えられる回数を、リンクと IP の組ごと（少なめ）と、リンクごと（多め）で決める。合っていたら数えない。
  // 組ごとを先に見るので、URL だけ知っている 1 人がわざと間違え続けても、ほかの人は開けられる
  const day = new Date().toISOString().slice(0, 10);
  const busy = () => html(renderLocked(lang, id, "busy", editorScript), 429, { "Cache-Control": "no-store", "Retry-After": String(secondsUntilUTCMidnight()), ...lockedCSP });
  const perIP = env.QUOTA.get(env.QUOTA.idFromName(`unlock:${id}:${await ipPseudonym(secret, clientIP(request), day)}`));
  if (!(await perIP.consume(day, 0, Number(env.QUOTA_UNLOCK_IP_FAILURES) || 20, Number.MAX_SAFE_INTEGER))) return busy();
  const perLink = env.QUOTA.get(env.QUOTA.idFromName(`unlock:${id}`));
  if (!(await perLink.consume(day, 0, Number(env.QUOTA_UNLOCK_FAILURES) || 300, Number.MAX_SAFE_INTEGER))) {
    await perIP.refund(day, 0);
    return busy();
  }
  if (!(await verifyPassword(shot.pw, candidate))) return html(renderLocked(lang, id, "wrong", editorScript), 401, { "Cache-Control": "no-store", ...lockedCSP });
  await Promise.all([perIP.refund(day, 0), perLink.refund(day, 0)]);
  const expires = Date.now() + UNLOCK_SECONDS * 1000;
  const isHTTPS = new URL(request.url).protocol === "https:";
  const secure = isHTTPS ? "; Secure" : "";
  const cookie = `${await unlockCookieName(id, isHTTPS)}=${expires}.${await hmacHex(secret, `unlock|${id}|${shot.pw}|${expires}`)}`;
  return seeOther({ "Set-Cookie": `${cookie}; Path=/; Max-Age=${UNLOCK_SECONDS}; HttpOnly; SameSite=Lax${secure}` });
}

// MARK: - 通報

async function report(request: Request, env: Env, ctx: ExecutionContext, id: string, lang: Lang): Promise<Response> {
  // 閲覧ページのフォームからだけ受け付ける（ほかのサイトに代わりに送らせない）
  if (!isSameOriginPost(request)) return json({ error: "forbidden" }, 403);
  const { success } = await env.REPORT_IP_LIMIT.limit({ key: clientIP(request) });
  if (!success) return tooManyRequests();
  if (!(await findShot(env, ctx, id, false))) return notFound(lang);
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

async function consumeDailyQuota(env: Env, secret: string, owner: string, ip: string, bytes: number): Promise<QuotaResult> {
  const day = new Date().toISOString().slice(0, 10);
  const n = (value: string | undefined, fallback: number) => Number(value) || fallback;
  const scopes: Array<[string, number, number, QuotaResult]> = [
    [`key:${owner}`, n(env.QUOTA_KEY_UPLOADS, 100), n(env.QUOTA_KEY_BYTES, 200_000_000), "personal"],
    // IP は秘密の鍵と日付で HMAC にしてから名前にする（元の IP に戻せず、日をまたいで結び付かない）
    [`ip:${await ipPseudonym(secret, ip, day)}`, n(env.QUOTA_IP_UPLOADS, 300), n(env.QUOTA_IP_BYTES, 500_000_000), "personal"],
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

/** テストから、数える単位の名前を作るために使う */
export const ipPseudonymForTest = (env: Env, ip: string, day: string) =>
  ipPseudonym((env as Env & { QUOTA_SECRET?: string }).QUOTA_SECRET || LOCAL_SECRET, ipBucket(ip), day);

async function ipPseudonym(secret: string, ip: string, day: string): Promise<string> {
  return hmacHex(secret, `${day}|${ip}`);
}

function secondsUntilUTCMidnight(now = Date.now()): number {
  return Math.max(60, Math.ceil((DAY_MS - (now % DAY_MS)) / 1000));
}

/**
 * 範囲（端末キー・IP・全体）ごとに 1 つ。1 日の件数とバイト数を SQLite に持つ。
 * 前の日の行はアラームで消し、何も残らなければ保存領域ごと消す（IP 由来の記録を長く持たない）。
 */
export class UsageQuota extends DurableObject<Env> {
  // One object per image serializes the R2 read/check/write across all Worker instances.
  async appendVersion(shotKey: string, input: VersionInput): Promise<VersionSummary | "full" | "gone"> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if ((await listVersions(this.env, shotKey)).length >= MAX_VERSIONS) return "full" as const;
      const createdAt = Date.now();
      const v = `${String(createdAt).padStart(13, "0")}-${newShotID(6)}`;
      const key = `${versionPrefix(shotKey)}${v}.json`;
      await this.env.SHOTS.put(key, JSON.stringify({ v, createdAt, ...input }), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { label: encodeURIComponent(input.label) },
      });
      if (!(await this.env.SHOTS.head(shotKey))) {
        await this.env.SHOTS.delete(key);
        return "gone" as const;
      }
      return { v, createdAt, label: input.label };
    });
  }

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
      edit: object.customMetadata?.edit ?? "",
      pw: object.customMetadata?.pw ?? "",
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
    ctx.waitUntil(env.SHOTS.delete(shot.key).then(() => deleteVersions(env, shot.key)));
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

export function newShotID(byteLength = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
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
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
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
 * 無い古いブラウザだけ Origin で比べる。どちらも無いリクエストは拒否する（フェイルクローズ）。
 */
export function isSameOriginPost(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("Origin");
  return origin !== null && origin === new URL(request.url).origin;
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
    // 常に HTTPS で開かせる（独自ドメインにしたときのため。workers.dev はもともと HTTPS のみ）
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
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
