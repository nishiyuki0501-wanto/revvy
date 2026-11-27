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

const post = (body, auth, retention = "30d") => fetch(`${base}/api/v1/shots?retention=${retention}`, {
  method: "POST", body, headers: { "Content-Type": "image/jpeg", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
});
const del = (id, auth) => fetch(`${base}/api/v1/shots/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${auth}` } });

const created = await post(jpeg, owner);
check("upload returns 201", created.status === 201, String(created.status));
const shot = await created.json();
check("id is 22 chars", /^[A-Za-z0-9_-]{22}$/.test(shot.id), shot.id);
check("30d has expiry", typeof shot.expiresAt === "string", shot.expiresAt);

const page = await fetch(shot.url, { headers: { "Accept-Language": "ja" } });
const html = await page.text();
check("viewer page 200", page.status === 200);
check("viewer has og:image", html.includes(`og:image" content="${shot.imageURL}"`));
check("viewer is noindex", (page.headers.get("x-robots-tag") ?? "").includes("noindex"));

const image = await fetch(shot.imageURL);
check("image bytes match", Buffer.from(await image.arrayBuffer()).equals(jpeg));
check("image is image/jpeg", image.headers.get("content-type") === "image/jpeg");

check("no key → 401", (await post(jpeg, null)).status === 401);
check("not an image → 415", (await post(Buffer.from("<html>"), owner)).status === 415);
check("other device cannot delete → 403", (await del(shot.id, key())).status === 403);
check("owner deletes → 204", (await del(shot.id, owner)).status === 204);
check("deleted page → 404", (await fetch(shot.url)).status === 404);
check("deleted image → 404", (await fetch(shot.imageURL)).status === 404);

const forever = await (await post(jpeg, owner, "forever")).json();
check("forever has no expiry", forever.expiresAt === null);
check("forever cleanup → 204", (await del(forever.id, owner)).status === 204);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
