import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { MAX_VERSIONS } from "../src/limits";
import { ID_PATTERN, parseVersion, VERSION_ID_PATTERN, ipBucket, sha256Hex, sniffImageType, type UsageQuota } from "../src/index";

const ORIGIN = "https://share.example";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

let ipCounter = 0;
/** テストごとに IP を変えて、レート制限が他のテストに影響しないようにする */
function freshIP(): string { ipCounter += 1; return `203.0.113.${ipCounter}`; }

function deviceKey(seed: string): string {
  return (seed + "A".repeat(43)).slice(0, 43).replace(/[^A-Za-z0-9_-]/g, "A");
}

/** アップロードで返ってきた編集用の合言葉（ID ごと） */
const editTokens = new Map<string, string>();
const b64url = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

async function upload(body: BodyInit, opts: { key?: string; retention?: string; ip?: string; type?: string; id?: string; password?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.retention) params.set("retention", opts.retention);
  if (opts.id) params.set("id", opts.id);
  const query = params.size ? `?${params}` : "";
  const headers: Record<string, string> = { "CF-Connecting-IP": opts.ip ?? freshIP(), "Content-Type": opts.type ?? "image/jpeg" };
  if (opts.key !== undefined) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.password !== undefined) headers["X-Share-Secret"] = b64url(opts.password);
  const res = await exports.default.fetch(new Request(`${ORIGIN}/api/v1/shots${query}`, { method: "POST", body, headers }));
  if (res.status === 201) {
    const made = await res.clone().json<{ id: string; editURL: string }>();
    editTokens.set(made.id, made.editURL.split("#edit=")[1]);
  }
  return res;
}

function get(path: string, ip = freshIP(), lang = "ja", cookie = "") {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { headers: { "CF-Connecting-IP": ip, "Accept-Language": lang, ...(cookie ? { Cookie: cookie } : {}) } }));
}

function del(id: string, key: string) {
  return exports.default.fetch(new Request(`${ORIGIN}/api/v1/shots/${id}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${key}`, "CF-Connecting-IP": freshIP() },
  }));
}

type Uploaded = { id: string; url: string; imageURL: string; retention: string; expiresAt: string | null };

describe("upload", () => {
  it("stores a JPEG for 30 days by default and returns an unguessable link", async () => {
    const key = deviceKey("alice");
    const before = Date.now();
    const res = await upload(JPEG, { key });
    expect(res.status).toBe(201);
    const body = await res.json<Uploaded>();
    expect(body.id).toMatch(ID_PATTERN);
    expect(body.id).toHaveLength(22);
    expect(body.url).toBe(`${ORIGIN}/${body.id}`);
    expect(body.retention).toBe("30d");
    const expires = Date.parse(body.expiresAt!);
    expect(expires - before).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000);
    expect(expires - before).toBeLessThanOrEqual(30 * 86_400_000 + 5000);

    const stored = await env.SHOTS.head(`t30/${body.id}`);
    expect(stored?.httpMetadata?.contentType).toBe("image/jpeg");
    // 端末キーそのものは保存しない
    expect(stored?.customMetadata?.owner).toBe(await sha256Hex(key));
    expect(JSON.stringify(stored?.customMetadata)).not.toContain(key);
  });

  it("issues a 43-character ID when the app asks for a long one, and serves it like any other", async () => {
    const key = deviceKey("long");
    const res = await upload(JPEG, { key, id: "long" });
    expect(res.status).toBe(201);
    const body = await res.json<Uploaded>();
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.url).toBe(`${ORIGIN}/${body.id}`);
    expect((await get(`/${body.id}`)).status).toBe(200);
    expect((await get(`/i/${body.id}`)).status).toBe(200);
    expect((await del(body.id, deviceKey("someone-else"))).status).toBe(403);
    expect((await del(body.id, key)).status).toBe(204);
    expect((await get(`/${body.id}`)).status).toBe(404);
  });

  it("rejects unknown ID formats and IDs of other lengths", async () => {
    for (const id of ["constructor", "toString", "huge", ""]) {
      const res = await upload(JPEG, { key: deviceKey("idfmt"), id: id || " " });
      expect(res.status).toBe(400);
    }
    for (const length of [21, 23, 42, 44, 65]) {
      expect(ID_PATTERN.test("a".repeat(length))).toBe(false);
    }
    expect(ID_PATTERN.test("a".repeat(22))).toBe(true);
    expect(ID_PATTERN.test("a".repeat(43))).toBe(true);
  });

  it("keeps forever uploads under a prefix without a lifecycle rule", async () => {
    const res = await upload(PNG, { key: deviceKey("bob"), retention: "forever", type: "application/octet-stream" });
    expect(res.status).toBe(201);
    const body = await res.json<Uploaded>();
    expect(body.expiresAt).toBeNull();
    expect(await env.SHOTS.head(`keep/${body.id}`)).not.toBeNull();
    expect(await env.SHOTS.head(`t30/${body.id}`)).toBeNull();
    // Content-Type の申告ではなく中身で判定する
    expect((await env.SHOTS.head(`keep/${body.id}`))?.httpMetadata?.contentType).toBe("image/png");
  });

  it("generates a different id every time", async () => {
    const key = deviceKey("carol");
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await (await upload(JPEG, { key })).json<Uploaded>()).id);
    expect(ids.size).toBe(5);
  });

  it("rejects requests without a valid device key", async () => {
    expect((await upload(JPEG)).status).toBe(401);
    expect((await upload(JPEG, { key: "short" })).status).toBe(401);
    expect((await upload(JPEG, { key: "x".repeat(42) + "!" })).status).toBe(401);
  });

  it("rejects images with other data appended after the end marker", async () => {
    const appended = new Uint8Array([...JPEG, ...new TextEncoder().encode("PK hidden zip")]);
    expect((await upload(appended, { key: deviceKey("tail") })).status).toBe(415);
    const pngTail = new Uint8Array([...PNG, 1, 2, 3]);
    expect((await upload(pngTail, { key: deviceKey("tail2") })).status).toBe(415);
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
  });

  it("rejects things that are not JPEG or PNG, even if they claim to be", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect((await upload(html, { key: deviceKey("dave"), type: "image/jpeg" })).status).toBe(415);
    expect((await upload(new Uint8Array(), { key: deviceKey("dave") })).status).toBe(400);
  });

  it("rejects unknown retention values", async () => {
    expect((await upload(JPEG, { key: deviceKey("erin"), retention: "90d" })).status).toBe(400);
  });

  it("rejects oversized uploads", async () => {
    const big = new Uint8Array(Number(env.MAX_UPLOAD_BYTES) + 1);
    big.set(JPEG);
    expect((await upload(big, { key: deviceKey("frank") })).status).toBe(413);
  });

  it("rate-limits one device key even across IPs", async () => {
    const key = deviceKey("greedy");
    const statuses: number[] = [];
    // A fixed-minute window can roll over during the loop.
    for (let i = 0; i < 21 && !statuses.includes(429); i++) statuses.push((await upload(JPEG, { key })).status);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("rate-limits one IP even with fresh keys", async () => {
    const ip = freshIP();
    const statuses: number[] = [];
    for (let i = 0; i < 61 && !statuses.includes(429); i++) statuses.push((await upload(JPEG, { key: deviceKey(`k${i}x`), ip })).status);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("abuse protection", () => {
  it("rejects inherited property names as retention (they would bypass the lifecycle rule)", async () => {
    for (const retention of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect((await upload(JPEG, { key: deviceKey(`p${retention}`), retention })).status).toBe(400);
    }
    const listed = await env.SHOTS.list();
    expect(listed.objects.some((o) => o.key.startsWith("undefined"))).toBe(false);
  });

  it("stops reading a chunked body without Content-Length once it is too large", async () => {
    const max = Number(env.MAX_UPLOAD_BYTES);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > max * 3) { controller.close(); return; }
        const chunk = new Uint8Array(1_000_000);
        if (sent === 0) chunk.set(JPEG);
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const res = await exports.default.fetch(new Request(`${ORIGIN}/api/v1/shots`, {
      method: "POST", body: stream, duplex: "half",
      headers: { Authorization: `Bearer ${deviceKey("chunky")}`, "CF-Connecting-IP": freshIP() },
    } as RequestInit));
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(max * 3);
  });

  it("counts uploads per day and refuses once a limit is reached", async () => {
    const counter = env.QUOTA.get(env.QUOTA.idFromName("unit-test"));
    expect(await counter.consume("2026-11-26", 10, 2, 100)).toBe(true);
    expect(await counter.consume("2026-11-26", 10, 2, 100)).toBe(true);
    expect(await counter.consume("2026-11-26", 10, 2, 100)).toBe(false);
    // 翌日はまた数え直す
    expect(await counter.consume("2026-11-27", 10, 2, 100)).toBe(true);
    // バイト数の上限も効く
    expect(await counter.consume("2026-11-27", 95, 10, 100)).toBe(false);
  });

  it("forgets old counters so IP-derived records do not linger", async () => {
    const stub = env.QUOTA.get(env.QUOTA.idFromName("cleanup-test"));
    expect(await stub.consume("2000-01-01", 1, 10, 100)).toBe(true);
    await runInDurableObject(stub, async (instance: UsageQuota, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      await instance.alarm();
      // 前の日の行しか無かったので、保存領域ごと消える
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.sql.databaseSize).toBeLessThan(16_384);
    });
    // 消えたあとも、また数えられる
    expect(await stub.consume(new Date().toISOString().slice(0, 10), 1, 10, 100)).toBe(true);
  });

  it("returns 429 daily_quota once a device key used up today's allowance", async () => {
    const key = deviceKey("quotaful");
    const owner = await sha256Hex(key);
    const counter = env.QUOTA.get(env.QUOTA.idFromName(`key:${owner}`));
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < Number(env.QUOTA_KEY_UPLOADS); i++) await counter.consume(day, 1, 1_000_000, 1_000_000_000);
    const res = await upload(JPEG, { key });
    expect(res.status).toBe(429);
    expect((await res.json<{ error: string }>()).error).toBe("daily_quota");
  });

  it("groups IPv6 addresses by /56 so rotating /64s does not escape the limits", () => {
    expect(ipBucket("2001:db8:abcd:12ff:1::1")).toBe("2001:0db8:abcd:1200::/56");
    expect(ipBucket("2001:db8:abcd:1234::9")).toBe("2001:0db8:abcd:1200::/56");
    expect(ipBucket("2001:db8:abcd:13aa::9")).toBe("2001:0db8:abcd:1300::/56");
    expect(ipBucket("203.0.113.5")).toBe("203.0.113.5");
    expect(ipBucket("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(ipBucket("::FFFF:198.51.100.42")).toBe("198.51.100.42");
  });

  it("rate-limits a whole IPv6 /56 together", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      statuses.push((await upload(JPEG, { key: deviceKey(`v6${i}x`), ip: `2001:db8:feed:42${(i % 16).toString(16)}0::${i + 1}` })).status);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it("gives back the personal allowance when a later limit refuses", async () => {
    const counter = env.QUOTA.get(env.QUOTA.idFromName("refund-test"));
    expect(await counter.consume("2026-11-26", 10, 1, 100)).toBe(true);
    expect(await counter.consume("2026-11-26", 10, 1, 100)).toBe(false);
    await counter.refund("2026-11-26", 10);
    expect(await counter.consume("2026-11-26", 10, 1, 100)).toBe(true);
  });

  it("refuses reports posted from other websites", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("csrf") })).json<Uploaded>();
    const form = new FormData();
    form.set("reason", "other");
    const crossSite = await exports.default.fetch(new Request(`${ORIGIN}/${id}/report`, {
      method: "POST", body: form, headers: { "CF-Connecting-IP": freshIP(), Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    }));
    expect(crossSite.status).toBe(403);
    const sameSite = await exports.default.fetch(new Request(`${ORIGIN}/${id}/report`, {
      method: "POST", body: form, headers: { "CF-Connecting-IP": freshIP(), Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    }));
    expect(sameSite.status).toBe(200);
    // ブラウザが Origin: null を付けても、Sec-Fetch-Site が same-origin なら受け付ける
    const nullOrigin = await exports.default.fetch(new Request(`${ORIGIN}/${id}/report`, {
      method: "POST", body: form, headers: { "CF-Connecting-IP": freshIP(), Origin: "null", "Sec-Fetch-Site": "same-origin" },
    }));
    expect(nullOrigin.status).toBe(200);
    // Sec-Fetch-Site の無い古いブラウザは Origin で判断し、どちらも無いリクエストは拒否する
    const oldBrowserCrossSite = await exports.default.fetch(new Request(`${ORIGIN}/${id}/report`, {
      method: "POST", body: form, headers: { "CF-Connecting-IP": freshIP(), Origin: "https://evil.example" },
    }));
    expect(oldBrowserCrossSite.status).toBe(403);
    const missingBoth = await exports.default.fetch(new Request(`${ORIGIN}/${id}/report`, {
      method: "POST", body: form, headers: { "CF-Connecting-IP": freshIP() },
    }));
    expect(missingBoth.status).toBe(403);
  });

  it("rejects oversized report bodies", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("rep2") })).json<Uploaded>();
    const form = new FormData();
    form.set("reason", "other");
    form.set("detail", "x".repeat(20_000));
    const res = await exports.default.fetch(new Request(`${ORIGIN}/${id}/report`, {
      method: "POST", body: form, headers: { "CF-Connecting-IP": freshIP(), "Sec-Fetch-Site": "same-origin" },
    }));
    expect(res.status).toBe(413);
  });
});

describe("viewing", () => {
  it("serves a viewer page with OGP, noindex and the expiry date", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("viewer") })).json<Uploaded>();
    const res = await get(`/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const page = await res.text();
    expect(page).toContain(`<meta property="og:image" content="${ORIGIN}/i/${id}">`);
    expect(page).toContain('name="robots" content="noindex');
    expect(page).toContain("に自動で削除されます");
    expect(page).toContain("あと 30 日");
    expect(page).toContain("JPEG");
    expect(page).toContain(`href="${ORIGIN}/i/${id}" download="revvy-`);
    // スクリプトは自分のサーバーの /editor.js だけ。インラインでは書かない
    expect(page.match(/<script/g)).toHaveLength(1);
    expect(page).toMatch(/<script src="\/editor\.js\?v=[0-9a-z]+" defer><\/script>/);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self';");
    expect(res.headers.get("Content-Security-Policy")).not.toContain("unsafe-eval");
  });

  it("serves the app icon for the page header", async () => {
    const res = await get("/icon.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect([...new Uint8Array(await res.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("serves the image bytes with a fixed type and nosniff", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("img") })).json<Uploaded>();
    const res = await get(`/i/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
  });

  it("says forever uploads are kept until deleted", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("keep"), retention: "forever" })).json<Uploaded>();
    const page = await (await get(`/${id}`, freshIP(), "en")).text();
    expect(page).toContain("Kept until the person who shared it deletes it");
  });

  it("hides expired images even before the lifecycle rule removes them", async () => {
    const id = "expiredAAAAAAAAAAAAAAA";
    await env.SHOTS.put(`t30/${id}`, JPEG, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { owner: "x", createdAt: "0", expiresAt: String(Date.now() - 1000) },
    });
    expect((await get(`/${id}`)).status).toBe(404);
    expect((await get(`/i/${id}`)).status).toBe(404);
  });

  it("returns 404 for unknown or malformed ids", async () => {
    expect((await get("/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await get("/i/../../etc")).status).toBe(404);
    expect((await get("/<script>")).status).toBe(404);
  });

  it("blocks robots entirely", async () => {
    expect(await (await get("/robots.txt")).text()).toContain("Disallow: /");
  });
});

describe("deleting", () => {
  it("lets only the uploading device delete", async () => {
    const owner = deviceKey("owner");
    const { id } = await (await upload(JPEG, { key: owner })).json<Uploaded>();
    expect((await del(id, deviceKey("intruder"))).status).toBe(403);
    expect((await get(`/i/${id}`)).status).toBe(200);
    expect((await del(id, owner)).status).toBe(204);
    expect((await get(`/i/${id}`)).status).toBe(404);
    expect((await get(`/${id}`)).status).toBe(404);
    expect((await del(id, owner)).status).toBe(404);
  });

  it("deletes forever uploads too", async () => {
    const owner = deviceKey("owner2");
    const { id } = await (await upload(JPEG, { key: owner, retention: "forever" })).json<Uploaded>();
    expect((await del(id, owner)).status).toBe(204);
    expect(await env.SHOTS.head(`keep/${id}`)).toBeNull();
  });
});

describe("terms and contact", () => {
  it("serves the terms in Japanese and English", async () => {
    expect(await (await get("/terms")).text()).toContain("上げてはいけないもの");
    expect(await (await get("/terms", freshIP(), "en")).text()).toContain("What you must not upload");
  });

  it("stores contact messages privately, without the sender's IP, and only from its own form", async () => {
    expect(await (await get("/contact")).text()).toContain('action="/contact"');
    const form = new FormData();
    form.set("topic", "removal");
    form.set("link", "https://share.example/abc");
    form.set("message", "この画像を消してください <b>");
    form.set("reply", "someone@example.com");
    const post = (headers: Record<string, string>) => exports.default.fetch(new Request(`${ORIGIN}/contact`, { method: "POST", body: form, headers }));
    expect((await post({ "CF-Connecting-IP": "198.51.100.9", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post({ "CF-Connecting-IP": "198.51.100.9", "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    const listed = await env.SHOTS.list({ prefix: "reports/contact-" });
    expect(listed.objects.length).toBe(1);
    const saved = await (await env.SHOTS.get(listed.objects[0].key))!.text();
    expect(saved).toContain("someone@example.com");
    expect(saved).not.toContain("198.51.100.9");
    const empty = new FormData();
    empty.set("message", "   ");
    expect((await exports.default.fetch(new Request(`${ORIGIN}/contact`, { method: "POST", body: empty, headers: { "CF-Connecting-IP": freshIP(), "Sec-Fetch-Site": "same-origin" } }))).status).toBe(400);
  });

  it("links terms and contact from the viewer page", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("footer") })).json<Uploaded>();
    const page = await (await get(`/${id}`)).text();
    expect(page).toContain('href="/terms"');
    expect(page).toContain('href="/contact"');
  });
});

function saveVersion(id: string, body: unknown, opts: { ip?: string; crossSite?: boolean; raw?: string; token?: string; cookie?: string } = {}) {
  return exports.default.fetch(new Request(`${ORIGIN}/api/v1/shots/${id}/versions`, {
    method: "POST",
    body: opts.raw ?? JSON.stringify(body),
    headers: {
      "CF-Connecting-IP": opts.ip ?? freshIP(), "Content-Type": "application/json",
      Origin: opts.crossSite ? "https://evil.example" : ORIGIN, "Sec-Fetch-Site": opts.crossSite ? "cross-site" : "same-origin",
      "X-Edit-Token": opts.token ?? editTokens.get(id) ?? "", ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
  }));
}

const RULER = { t: "ruler", x1: 10, y1: 20, x2: 11, y2: 20, color: "#E5484D", width: 2 };
const NOTE = { t: "text", x: 5, y: 6, size: 14, color: "#111111", text: "ここを直す\n2 行目" };

type VersionList = { versions: { v: string; createdAt: number; label: string }[] };

describe("versions (annotations added in the browser)", () => {
  it("saves annotations as a new version without touching the image, and lists them in order", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("ver") })).json<Uploaded>();
    expect((await (await get(`/api/v1/shots/${id}/versions`)).json<VersionList>()).versions).toEqual([]);

    const first = await saveVersion(id, { width: 100, height: 50, items: [RULER], label: " 寸法の確認 " });
    expect(first.status).toBe(201);
    const saved = await first.json<{ v: string; createdAt: number; label: string }>();
    expect(saved.v).toMatch(VERSION_ID_PATTERN);
    expect(saved.label).toBe("寸法の確認");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await (await saveVersion(id, { width: 100, height: 50, items: [RULER, NOTE] })).json<{ v: string }>();

    const list = await (await get(`/api/v1/shots/${id}/versions`)).json<VersionList>();
    expect(list.versions.map((version) => version.v)).toEqual([saved.v, second.v]);
    expect(list.versions[0].label).toBe("寸法の確認");

    const body = await (await get(`/api/v1/shots/${id}/versions/${second.v}`)).json<{ items: unknown[]; width: number }>();
    expect(body.width).toBe(100);
    expect(body.items).toEqual([{ ...RULER, color: "#e5484d" }, NOTE]);
    // 画像そのものは変わらない
    expect(new Uint8Array(await (await get(`/i/${id}`)).arrayBuffer())).toEqual(JPEG);
    // 保存した内容に IP は入らない
    const stored = await env.SHOTS.get(`t30/${id}.v/${second.v}.json`);
    expect(await stored!.text()).not.toContain("203.0.113");
  });

  it("keeps only known fields and rejects anything malformed", async () => {
    expect(parseVersion({ width: 10, height: 10, items: [{ ...RULER, onclick: "x", href: "javascript:alert(1)" }], extra: 1 }))
      .toEqual({ width: 10, height: 10, label: "", items: [{ ...RULER, color: "#e5484d" }] });
    expect(parseVersion({ width: 10, height: 10, items: [{ ...NOTE, text: "a\x00b\x1b[31m" }] })?.items[0]).toMatchObject({ text: "ab[31m" });
    const bad: unknown[] = [
      null, [], "x", { width: 10, height: 10 }, { width: 0, height: 10, items: [] }, { width: 10, height: 10, items: [], label: 5 },
      { width: 10, height: 10, items: [{ ...RULER, color: "red" }] },
      { width: 10, height: 10, items: [{ ...RULER, color: "url(#x)" }] },
      { width: 10, height: 10, items: [{ ...RULER, t: "image" }] },
      { width: 10, height: 10, items: [{ ...RULER, t: "constructor" }] },
      { width: 10, height: 10, items: [{ ...RULER, x1: "10" }] },
      { width: 10, height: 10, items: [{ ...RULER, x1: 1e9 }] },
      { width: 10, height: 10, items: [{ ...RULER, width: 0 }] },
      { width: 10, height: 10, items: [{ ...NOTE, text: "   " }] },
      { width: 10, height: 10, items: [{ ...NOTE, text: "a".repeat(501) }] },
      { width: 10, height: 10, items: [{ t: "pen", color: "#111111", width: 2, points: [1, 2, 3] }] },
      { width: 10, height: 10, items: [{ t: "pen", color: "#111111", width: 2, points: [1, 2, 3, null] }] },
      { width: 10, height: 10, items: Array.from({ length: 301 }, () => RULER) },
    ];
    for (const input of bad) expect(parseVersion(input)).toBeNull();

    const { id } = await (await upload(JPEG, { key: deviceKey("verbad") })).json<Uploaded>();
    expect((await saveVersion(id, { width: 10, height: 10, items: [{ ...RULER, t: "image" }] })).status).toBe(400);
    expect((await saveVersion(id, null, { raw: "not json" })).status).toBe(400);
    expect((await saveVersion(id, null, { raw: JSON.stringify({ width: 10, height: 10, items: [], label: "a".repeat(70_000) }) })).status).toBe(413);
    expect((await (await get(`/api/v1/shots/${id}/versions`)).json<VersionList>()).versions).toEqual([]);
  });

  it("only accepts saves from the viewer page itself, for links that exist", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("vercsrf") })).json<Uploaded>();
    expect((await saveVersion(id, { width: 10, height: 10, items: [RULER] }, { crossSite: true })).status).toBe(403);
    expect((await saveVersion("a".repeat(43), { width: 10, height: 10, items: [RULER] })).status).toBe(404);
    expect((await get(`/api/v1/shots/${"a".repeat(43)}/versions`)).status).toBe(404);
    expect((await get(`/api/v1/shots/${id}/versions/0000000000000-aaaaaaaa`)).status).toBe(404);
    expect((await get(`/api/v1/shots/${id}/versions/..%2F..%2Fkeep`)).status).toBe(404);
  });

  it("deletes the versions together with the image", async () => {
    const key = deviceKey("verdel");
    const { id } = await (await upload(JPEG, { key })).json<Uploaded>();
    const { v } = await (await saveVersion(id, { width: 10, height: 10, items: [RULER] })).json<{ v: string }>();
    expect((await env.SHOTS.list({ prefix: `t30/${id}.v/` })).objects).toHaveLength(1);
    expect((await del(id, key)).status).toBe(204);
    expect((await env.SHOTS.list({ prefix: `t30/${id}` })).objects).toHaveLength(0);
    expect((await get(`/api/v1/shots/${id}/versions/${v}`)).status).toBe(404);
  });

  it("stops at the version limit", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("vercap") })).json<Uploaded>();
    for (let i = 0; i < MAX_VERSIONS - 1; i += 1) {
      expect((await saveVersion(id, { width: 10, height: 10, items: [RULER] })).status).toBe(201);
    }
    const responses = await Promise.all(Array.from({ length: 4 }, () =>
      saveVersion(id, { width: 10, height: 10, items: [RULER] })));
    expect(responses.map(r => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect((await env.SHOTS.list({ prefix: `t30/${id}.v/` })).objects).toHaveLength(MAX_VERSIONS);
    expect((await saveVersion(id, { width: 10, height: 10, items: [RULER] })).status).toBe(409);
  });

  it("serves the editor script as JavaScript from the same origin", async () => {
    const res = await get("/editor.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const source = await res.text();
    expect(source).toContain("/api/v1/shots/");
    // 保存された文字列を HTML として差し込む書き方をしていない
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
});

describe("edit links, passwords and short retention", () => {
  it("lets only the holder of the edit link save annotations", async () => {
    const res = await upload(JPEG, { key: deviceKey("editlink"), id: "long" });
    const made = await res.json<Uploaded & { editURL: string }>();
    expect(made.editURL).toMatch(new RegExp(`^${ORIGIN}/${made.id}#edit=[A-Za-z0-9_-]{43}$`));
    const token = made.editURL.split("#edit=")[1];
    // 合言葉そのものは保存しない
    const stored = await env.SHOTS.head(`t30/${made.id}`);
    expect(stored?.customMetadata?.edit).toBe(await sha256Hex(token));
    expect(JSON.stringify(stored?.customMetadata)).not.toContain(token);
    // 見るだけのページには合言葉が出ない
    expect(await (await get(`/${made.id}`)).text()).not.toContain(token);

    const body = { width: 10, height: 10, items: [RULER] };
    expect((await saveVersion(made.id, body, { token: "" })).status).toBe(403);
    expect((await saveVersion(made.id, body, { token: "x".repeat(43) })).status).toBe(403);
    const other = await (await upload(JPEG, { key: deviceKey("editlink2") })).json<Uploaded>();
    expect((await saveVersion(made.id, body, { token: editTokens.get(other.id) })).status).toBe(403);
    expect((await saveVersion(made.id, body, { token })).status).toBe(201);
    // 保存はできなくても、見ることはできる
    expect((await (await get(`/api/v1/shots/${made.id}/versions`)).json<VersionList>()).versions).toHaveLength(1);
  });

  it("refuses to save to links that have no edit link (made before edit links existed)", async () => {
    const id = "L".repeat(43);
    await env.SHOTS.put(`t30/${id}`, JPEG, { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { owner: "x", createdAt: "1", expiresAt: String(Date.now() + 86_400_000) } });
    expect((await get(`/${id}`)).status).toBe(200);
    expect((await saveVersion(id, { width: 10, height: 10, items: [RULER] }, { token: "" })).status).toBe(403);
  });

  const unlock = (id: string, password: string, opts: { ip?: string; crossSite?: boolean } = {}) => {
    const form = new FormData();
    form.set("password", password);
    return exports.default.fetch(new Request(`${ORIGIN}/${id}/unlock`, {
      method: "POST", body: form, redirect: "manual",
      headers: { "CF-Connecting-IP": opts.ip ?? freshIP(), "Accept-Language": "ja", "Sec-Fetch-Site": opts.crossSite ? "cross-site" : "same-origin" },
    }));
  };

  it("shows nothing about a password-protected link until the password is entered", async () => {
    const key = deviceKey("locked");
    const res = await upload(JPEG, { key, id: "long", password: "ひみつの合言葉1" });
    expect(res.status).toBe(201);
    const made = await res.json<Uploaded & { protected: boolean }>();
    expect(made.protected).toBe(true);
    // パスワードそのものは保存しない
    const stored = await env.SHOTS.head(`t30/${made.id}`);
    expect(stored?.customMetadata?.pw).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(stored?.customMetadata)).not.toContain("ひみつ");

    const gate = await get(`/${made.id}`);
    expect(gate.status).toBe(401);
    expect(gate.headers.get("Cache-Control")).toBe("no-store");
    const gateHTML = await gate.text();
    expect(gateHTML).toContain(`action="/${made.id}/unlock"`);
    expect(gateHTML).not.toContain("og:image");
    expect(gateHTML).not.toContain(`/i/${made.id}`);
    expect((await get(`/i/${made.id}`)).status).toBe(401);
    expect((await get(`/api/v1/shots/${made.id}/versions`)).status).toBe(401);
    expect((await saveVersion(made.id, { width: 10, height: 10, items: [RULER] })).status).toBe(401);

    expect((await unlock(made.id, "ひみつの合言葉1", { crossSite: true })).status).toBe(403);
    const wrong = await unlock(made.id, "まちがい");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("Set-Cookie")).toBeNull();
    expect(await wrong.text()).toContain("パスワードが違います");

    const ok = await unlock(made.id, "ひみつの合言葉1");
    expect(ok.status).toBe(303);
    expect(ok.headers.get("Location")).toBe(`/${made.id}`);
    const setCookie = ok.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/^__Host-rv_[0-9a-f]{16}=/);
    expect(setCookie).toMatch(/; HttpOnly/);
    expect(setCookie).toMatch(/; Secure/);
    expect(setCookie).toMatch(/; SameSite=Lax/);
    expect(setCookie).not.toContain(made.id);
    const cookie = setCookie.split(";")[0];

    const page = await get(`/${made.id}`, freshIP(), "ja", cookie);
    expect(page.status).toBe(200);
    // 同名の古い／壊れた Cookie が先に並んでいても、有効な Cookie があれば開ける（Cookie シャドーイング耐性）
    const [cookieName] = cookie.split("=");
    expect((await get(`/${made.id}`, freshIP(), "ja", `${cookieName}=0.${"0".repeat(64)}; ${cookie}`)).status).toBe(200);
    const pageHTML = await page.text();
    expect(pageHTML).toContain("パスワード付き");
    expect(pageHTML).not.toContain("og:image");
    const image = await get(`/i/${made.id}`, freshIP(), "ja", cookie);
    expect(image.status).toBe(200);
    expect(image.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await saveVersion(made.id, { width: 10, height: 10, items: [RULER] }, { cookie })).status).toBe(201);

    // 書き換えた Cookie、期限を延ばした Cookie、別のリンクの Cookie は通らない
    const [name, value] = cookie.split("=");
    const [expires, mac] = value.split(".");
    expect((await get(`/${made.id}`, freshIP(), "ja", `${name}=${Number(expires) + 1}.${mac}`)).status).toBe(401);
    expect((await get(`/${made.id}`, freshIP(), "ja", `${name}=${expires}.${"0".repeat(64)}`)).status).toBe(401);
    const second = await (await upload(JPEG, { key, id: "long", password: "ひみつの合言葉1" })).json<Uploaded>();
    expect((await get(`/${second.id}`, freshIP(), "ja", cookie)).status).toBe(401);
    expect((await get(`/${second.id}`, freshIP(), "ja", `${(await unlock(second.id, "ひみつの合言葉1")).headers.get("Set-Cookie")!.split("=")[0]}=${value}`)).status).toBe(401);

    // 持ち主は、パスワードなしで消せる
    expect((await del(made.id, key)).status).toBe(204);
    expect((await get(`/${made.id}`, freshIP(), "ja", cookie)).status).toBe(404);
  });

  it("rejects passwords that are too short, too long or malformed", async () => {
    const key = deviceKey("pwbad");
    expect((await upload(JPEG, { key, password: "1234567" })).status).toBe(400);
    expect((await upload(JPEG, { key, password: "a".repeat(129) })).status).toBe(400);
    expect((await upload(JPEG, { key, password: "abc\x00def" })).status).toBe(400);
    const made = await (await upload(JPEG, { key, password: "12345678" })).json<{ protected: boolean }>();
    expect(made.protected).toBe(true);
    const plain = await (await upload(JPEG, { key })).json<{ protected: boolean }>();
    expect(plain.protected).toBe(false);
  });

  it("stops guessing a password after too many wrong tries on one link", async () => {
    const made = await (await upload(JPEG, { key: deviceKey("pwbrute"), password: "correct horse" })).json<Uploaded>();
    const stub = env.QUOTA.get(env.QUOTA.idFromName(`unlock:${made.id}`));
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 300; i += 1) await stub.consume(day, 0, 300, Number.MAX_SAFE_INTEGER);
    const res = await unlock(made.id, "correct horse");
    expect(res.status).toBe(429);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("does not let one visitor lock everyone else out by guessing wrong", async () => {
    const made = await (await upload(JPEG, { key: deviceKey("pwlockout"), password: "correct horse" })).json<Uploaded>();
    const attacker = "198.51.100.77";
    // レート制限（毎分 10 回）とは別に、1 日 20 回で止まる。ここでは 1 日の上限だけを見るので、数えるところを直接進める
    const { ipPseudonymForTest } = await import("../src/index");
    const day = new Date().toISOString().slice(0, 10);
    const mine = env.QUOTA.get(env.QUOTA.idFromName(`unlock:${made.id}:${await ipPseudonymForTest(env, attacker, day)}`));
    for (let i = 0; i < 20; i += 1) await mine.consume(day, 0, 20, Number.MAX_SAFE_INTEGER);
    expect((await unlock(made.id, "correct horse", { ip: attacker })).status).toBe(429);
    // ほかの人は、正しいパスワードで開けられる
    expect((await unlock(made.id, "correct horse")).status).toBe(303);
  });

  it("tells the app what it supports before any image is sent", async () => {
    const caps = await (await get("/api/v1/capabilities")).json<{ password: boolean; minPasswordLength: number; editLinks: boolean; retentions: string[] }>();
    expect(caps).toEqual({ password: true, minPasswordLength: 8, editLinks: true, retentions: ["30d", "forever", "7d", "1d"] });
  });

  it("keeps the edit token working across the password page without leaving it in the URL", async () => {
    const made = await (await upload(JPEG, { key: deviceKey("pwedit"), password: "correct horse" })).json<Uploaded>();
    const gate = await get(`/${made.id}`);
    // 入口のページでも /editor.js だけは動く（合言葉をタブの中に取っておくため）。ほかのスクリプトは通さない
    expect(await gate.text()).toMatch(/<script src="\/editor\.js\?v=[0-9a-z]+" defer><\/script>/);
    expect(gate.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    const source = await (await get("/editor.js")).text();
    expect(source).toContain("sessionStorage.setItem");
    expect(source).toContain('history.replaceState(null, "", location.pathname + location.search)');
  });

  it("keeps 1-day and 7-day links in their own places with the right expiry", async () => {
    for (const [retention, prefix, days] of [["1d", "t1/", 1], ["7d", "t7/", 7]] as const) {
      const before = Date.now();
      const made = await (await upload(JPEG, { key: deviceKey("short" + retention), retention, id: "long" })).json<Uploaded>();
      expect(made.retention).toBe(retention);
      const expires = Date.parse(made.expiresAt!);
      expect(expires - before).toBeGreaterThanOrEqual(days * 86_400_000 - 1000);
      expect(expires - before).toBeLessThanOrEqual(days * 86_400_000 + 5000);
      const stored = await env.SHOTS.head(prefix + made.id);
      expect(stored).not.toBeNull();
      expect((await get(`/${made.id}`)).status).toBe(200);
      // 期限を過ぎたら、見られず、消える
      await env.SHOTS.put(prefix + made.id, JPEG, { httpMetadata: stored!.httpMetadata, customMetadata: { ...stored!.customMetadata, expiresAt: String(Date.now() - 1) } });
      expect((await get(`/${made.id}`)).status).toBe(404);
      expect((await get(`/i/${made.id}`)).status).toBe(404);
    }
  });
});

describe("reporting", () => {
  it("stores a report without the reporter's IP", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("reported") })).json<Uploaded>();
    const form = new FormData();
    form.set("reason", "personal");
    form.set("detail", "メールアドレスが写っています");
    const res = await exports.default.fetch(new Request(`${ORIGIN}/${id}/report`, {
      method: "POST", body: form, headers: { "CF-Connecting-IP": "198.51.100.7", "Accept-Language": "ja", "Sec-Fetch-Site": "same-origin" },
    }));
    expect(res.status).toBe(200);
    const listed = await env.SHOTS.list({ prefix: "reports/" });
    const mine = listed.objects.find((o) => o.key.includes(`-${id}-`) && o.key.endsWith(".json"));
    expect(mine).toBeDefined();
    const saved = await (await env.SHOTS.get(mine!.key))!.text();
    expect(saved).toContain("personal");
    expect(saved).not.toContain("198.51.100.7");
  });

  it("refuses to use the fallback secret in production when QUOTA_SECRET is missing, while allowing localhost", async () => {
    const worker = (await import("../src/index")).default;
    const withoutSecret = { ...env, QUOTA_SECRET: undefined } as unknown as Env;
    const prodUpload = await worker.fetch(new Request(`${ORIGIN}/api/v1/shots`, {
      method: "POST", body: JPEG, headers: { Authorization: `Bearer ${deviceKey("nosec")}`, "CF-Connecting-IP": freshIP() },
    }), withoutSecret, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(prodUpload.status).toBe(503);

    const localUpload = await worker.fetch(new Request("http://127.0.0.1:8787/api/v1/shots", {
      method: "POST", body: JPEG, headers: { Authorization: `Bearer ${deviceKey("localsec")}`, "CF-Connecting-IP": freshIP() },
    }), withoutSecret, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(localUpload.status).toBe(201);
  });
});
