// wrangler dev（または本番）に対して、アップロード → 閲覧 → 削除をひと通り確かめる。
// 使い方: npm run dev のあと  BASE=http://127.0.0.1:8787 npm run smoke
import { randomBytes } from "node:crypto";

const base = process.env.BASE ?? "http://127.0.0.1:8787";
const key = () => randomBytes(32).toString("base64url");
const owner = key();
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
}

const post = (body, auth, retention = "30d", legacy = false, password = "") => fetch(`${base}/api/v1/shots?retention=${retention}${legacy ? "" : "&id=long"}`, {
  method: "POST", body, headers: { "Content-Type": "image/jpeg", ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    ...(password ? { "X-Share-Secret": Buffer.from(password).toString("base64url") } : {}) },
});
const del = (id, auth) => fetch(`${base}/api/v1/shots/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${auth}` } });

const created = await post(jpeg, owner);
check("upload returns 201", created.status === 201, String(created.status));
const shot = await created.json();
check("id is 43 chars", /^[A-Za-z0-9_-]{43}$/.test(shot.id), shot.id);
// 0.3.0 のアプリは id=long を付けない。22 文字の ID が返り、同じように見られて消せること
const legacy = await (await post(jpeg, owner, "30d", true)).json();
check("legacy client gets 22 chars", /^[A-Za-z0-9_-]{22}$/.test(legacy.id), legacy.id);
check("legacy link opens", (await fetch(legacy.url)).status === 200);
check("legacy link deletes", (await del(legacy.id, owner)).status === 204);
check("30d has expiry", typeof shot.expiresAt === "string", shot.expiresAt);

const page = await fetch(shot.url, { headers: { "Accept-Language": "ja" } });
const html = await page.text();
check("viewer page 200", page.status === 200);
check("viewer has og:image", html.includes(`og:image" content="${shot.imageURL}"`));

// ブラウザでの書き込み：閲覧ページからの保存だけが通り、バージョンとして読める
const versionsURL = `${base}/api/v1/shots/${shot.id}/versions`;
const ink = { width: 2, height: 2, label: "smoke", items: [{ t: "ruler", x1: 0, y1: 0, x2: 1, y2: 0, color: "#e5484d", width: 1 }] };
const editToken = (shot.editURL ?? "").split("#edit=")[1] ?? "";
check("upload returns an edit link", /^[A-Za-z0-9_-]{43}$/.test(editToken));
const saveInk = (origin, site, token = editToken) => fetch(versionsURL, { method: "POST", body: JSON.stringify(ink), headers: { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": site, "X-Edit-Token": token } });
const scriptTag = html.match(/<script src="(\/editor\.js\?v=[0-9a-z]+)" defer>/);
check("viewer loads only its own editor script", scriptTag !== null && (page.headers.get("content-security-policy") ?? "").includes("script-src 'self'"));
check("editor script is served", scriptTag !== null && (await fetch(base + scriptTag[1])).headers.get("content-type")?.includes("javascript") === true);
check("cross-site save → 403", (await saveInk("https://evil.example", "cross-site")).status === 403);
check("view link cannot save → 403", (await saveInk(new URL(base).origin, "same-origin", "")).status === 403);
check("viewer page does not contain the edit token", !html.includes(editToken));
const savedInk = await saveInk(new URL(base).origin, "same-origin");
check("save version → 201", savedInk.status === 201, String(savedInk.status));
const { v } = await savedInk.json();
const listedInk = await (await fetch(versionsURL)).json();
check("version is listed", listedInk.versions?.length === 1 && listedInk.versions[0].v === v);
check("version reads back", (await (await fetch(`${versionsURL}/${v}`)).json()).items?.[0]?.t === "ruler");
check("viewer is noindex", (page.headers.get("x-robots-tag") ?? "").includes("noindex"));

const image = await fetch(shot.imageURL);
check("image bytes match", Buffer.from(await image.arrayBuffer()).equals(jpeg));
check("image is image/jpeg", image.headers.get("content-type") === "image/jpeg");

check("no key → 401", (await post(jpeg, null)).status === 401);
check("not an image → 415", (await post(Buffer.from("<html>"), owner)).status === 415);
check("other device cannot delete → 403", (await del(shot.id, key())).status === 403);
check("owner deletes → 204", (await del(shot.id, owner)).status === 204);
check("versions go with the image → 404", (await fetch(versionsURL)).status === 404);
check("deleted page → 404", (await fetch(shot.url)).status === 404);
check("deleted image → 404", (await fetch(shot.imageURL)).status === 404);

// パスワード付き：通すまで何も見せない。1 日のリンクで試す
const secret = "smoke-" + key().slice(0, 12);
const lockedShot = await (await post(jpeg, owner, "1d", false, secret)).json();
check("password link is marked protected", lockedShot.protected === true);
check("1d expires within a day", Date.parse(lockedShot.expiresAt) - Date.now() <= 86_400_000);
const gate = await fetch(lockedShot.url);
const gateHTML = await gate.text();
check("locked page → 401 with no image info", gate.status === 401 && !gateHTML.includes("og:image") && !gateHTML.includes("/i/" + lockedShot.id));
check("locked image → 401", (await fetch(lockedShot.imageURL)).status === 401);
check("locked versions → 401", (await fetch(`${base}/api/v1/shots/${lockedShot.id}/versions`)).status === 401);
const tryUnlock = (password) => fetch(`${lockedShot.url}/unlock`, { method: "POST", redirect: "manual", body: new URLSearchParams({ password }),
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(base).origin, "Sec-Fetch-Site": "same-origin" } });
const wrong = await tryUnlock("not-the-password");
check("wrong password → 401, no cookie", wrong.status === 401 && !wrong.headers.get("set-cookie"));
const opened = await tryUnlock(secret);
const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
check("right password → 303 with cookie", opened.status === 303 && cookie.includes("="));
check("unlocked page → 200", (await fetch(lockedShot.url, { headers: { Cookie: cookie } })).status === 200);
const lockedImage = await fetch(lockedShot.imageURL, { headers: { Cookie: cookie } });
check("unlocked image → 200, never cached", lockedImage.status === 200 && (lockedImage.headers.get("cache-control") ?? "").includes("no-store"));
check("locked cleanup → 204", (await del(lockedShot.id, owner)).status === 204);

const caps = await (await fetch(`${base}/api/v1/capabilities`)).json();
check("server reports password support", caps.password === true && caps.minPasswordLength === 8);

const forever = await (await post(jpeg, owner, "forever")).json();
check("forever has no expiry", forever.expiresAt === null);
check("forever cleanup → 204", (await del(forever.id, owner)).status === 204);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
