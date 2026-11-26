import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { ID_PATTERN, ipBucket, sha256Hex, sniffImageType, type UsageQuota } from "../src/index";

const ORIGIN = "https://share.example";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

let ipCounter = 0;
/** テストごとに IP を変えて、レート制限が他のテストに影響しないようにする */
function freshIP(): string { ipCounter += 1; return `203.0.113.${ipCounter}`; }

function deviceKey(seed: string): string {
  return (seed + "A".repeat(43)).slice(0, 43).replace(/[^A-Za-z0-9_-]/g, "A");
}

function upload(body: BodyInit, opts: { key?: string; retention?: string; ip?: string; type?: string } = {}) {
  const query = opts.retention ? `?retention=${opts.retention}` : "";
  const headers: Record<string, string> = { "CF-Connecting-IP": opts.ip ?? freshIP(), "Content-Type": opts.type ?? "image/jpeg" };
  if (opts.key !== undefined) headers.Authorization = `Bearer ${opts.key}`;
  return exports.default.fetch(new Request(`${ORIGIN}/api/v1/shots${query}`, { method: "POST", body, headers }));
}

function get(path: string, ip = freshIP(), lang = "ja") {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { headers: { "CF-Connecting-IP": ip, "Accept-Language": lang } }));
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
    expect((await upload(JPEG, { key: deviceKey("erin"), retention: "7d" })).status).toBe(400);
  });

  it("rejects oversized uploads", async () => {
    const big = new Uint8Array(Number(env.MAX_UPLOAD_BYTES) + 1);
    big.set(JPEG);
    expect((await upload(big, { key: deviceKey("frank") })).status).toBe(413);
  });

  it("rate-limits one device key even across IPs", async () => {
    const key = deviceKey("greedy");
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await upload(JPEG, { key })).status);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("rate-limits one IP even with fresh keys", async () => {
    const ip = freshIP();
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await upload(JPEG, { key: deviceKey(`k${i}x`), ip })).status);
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
    // Sec-Fetch-Site の無い古いブラウザは Origin で判断する
    const oldBrowserCrossSite = await exports.default.fetch(new Request(`${ORIGIN}/${id}/report`, {
      method: "POST", body: form, headers: { "CF-Connecting-IP": freshIP(), Origin: "https://evil.example" },
    }));
    expect(oldBrowserCrossSite.status).toBe(403);
  });

  it("rejects oversized report bodies", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("rep2") })).json<Uploaded>();
    const form = new FormData();
    form.set("reason", "other");
    form.set("detail", "x".repeat(20_000));
    const res = await exports.default.fetch(new Request(`${ORIGIN}/${id}/report`, {
      method: "POST", body: form, headers: { "CF-Connecting-IP": freshIP() },
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

describe("reporting", () => {
  it("stores a report without the reporter's IP", async () => {
    const { id } = await (await upload(JPEG, { key: deviceKey("reported") })).json<Uploaded>();
    const form = new FormData();
    form.set("reason", "personal");
    form.set("detail", "メールアドレスが写っています");
    const res = await exports.default.fetch(new Request(`${ORIGIN}/${id}/report`, {
      method: "POST", body: form, headers: { "CF-Connecting-IP": "198.51.100.7", "Accept-Language": "ja" },
    }));
    expect(res.status).toBe(200);
    const listed = await env.SHOTS.list({ prefix: "reports/" });
    const mine = listed.objects.find((o) => o.key.includes(`-${id}-`) && o.key.endsWith(".json"));
    expect(mine).toBeDefined();
    const saved = await (await env.SHOTS.get(mine!.key))!.text();
    expect(saved).toContain("personal");
    expect(saved).not.toContain("198.51.100.7");
  });
});
