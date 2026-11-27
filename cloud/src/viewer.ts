export type Lang = "ja" | "en";

const strings = {
  ja: {
    title: "Revvy で共有されたスクリーンショット",
    expires: (date: string) => `${date} に自動で削除されます`,
    forever: "保存期間: 無期限（共有した人が削除するまで）",
    open: "画像だけを開く",
    download: "ダウンロード",
    zoom: "クリックで拡大・縮小",
    noExpiry: "無期限",
    daysLeft: (days: number) => `あと ${days} 日`,
    shared: (date: string) => `${date} に共有`,
    getApp: "Revvy を入手",
    edit: "編集",
    lockedChip: "パスワード付き",
    locked: { title: "パスワードが必要です", lead: "このリンクはパスワードで保護されています。共有した人から聞いたパスワードを入力してください。", placeholder: "パスワード", submit: "開く",
      wrong: "パスワードが違います。", busy: "試した回数が多すぎます。しばらくしてから、もう一度お試しください。" },
    versions: "バージョン",
    tools: { select: "選択 (V)", text: "テキスト (T)", rect: "四角 (R)", ellipse: "丸 (O)", line: "線 (L)", arrow: "矢印 (A)", ruler: "ルーラー (M)", pen: "ペン (P)" },
    weights: ["1px（極細）", "細い", "ふつう", "太い"],
    undo: "取り消す", redo: "やり直す", remove: "選んだものを削除", zoomIn: "拡大 (+)", zoomOut: "縮小 (-)", zoomFit: "全体を表示 (0)",
    labelPlaceholder: "メモ（任意）",
    save: "バージョンを保存",
    done: "終了",
    hint: "近くをクリックで選択、ツールのダブルクリックで続けて描画、矢印キーで 1px 移動（Option／Alt で伸縮）。保存のたびに新しいバージョンが増え、元の画像と前のバージョンは残ります。書き込みを保存できるのは、この編集用リンクを持っている人だけです。",
    messages: {
      text: "テキスト", original: "元の画像（書き込みなし）",
      discard: "保存していない書き込みがあります。破棄して切り替えますか？",
      saved: "バージョン {n} として保存しました。", copy: "リンクをコピー", copied: "コピーしました",
      saveFailed: "保存できませんでした。しばらくしてから、もう一度お試しください。",
      loadFailed: "バージョンを読み込めませんでした。",
      tooMany: "これ以上は追加できません。",
      errors: { 401: "パスワードの有効時間が切れました。ページを読み込み直してください。", 403: "このリンクでは保存できません。編集用リンクから開いてください。", 404: "このリンクは削除されたか、保存期間が過ぎています。",
        409: "バージョンの数が上限（50）に達しています。", 413: "書き込みが多すぎて保存できません。",
        429: "短い時間に保存しすぎています。少し待ってから、もう一度お試しください。", 503: "サーバーが混み合っています。しばらくしてから、もう一度お試しください。" },
    },
    report: "問題のある画像を報告",
    reasons: [["personal", "個人情報が写っている"], ["illegal", "違法・有害な内容"], ["copyright", "著作権の侵害"], ["other", "その他"]],
    detail: "補足（任意）",
    send: "報告する",
    footer: "Revvy — Mac のスクリーンショットを、書き込んで共有するアプリ",
    termsLink: "利用規約",
    contactLink: "削除依頼・お問い合わせ",
  },
  en: {
    title: "Screenshot shared with Revvy",
    expires: (date: string) => `Deleted automatically on ${date}`,
    forever: "Kept until the person who shared it deletes it",
    open: "Open image only",
    download: "Download",
    zoom: "Click to zoom in or out",
    noExpiry: "No expiry",
    daysLeft: (days: number) => (days === 1 ? "1 day left" : `${days} days left`),
    shared: (date: string) => `Shared ${date}`,
    getApp: "Get Revvy",
    edit: "Edit",
    lockedChip: "Password protected",
    locked: { title: "Password required", lead: "This link is protected with a password. Enter the password you got from the person who shared it.", placeholder: "Password", submit: "Open",
      wrong: "That password is not correct.", busy: "Too many attempts. Please try again later." },
    versions: "Version",
    tools: { select: "Select (V)", text: "Text (T)", rect: "Rectangle (R)", ellipse: "Ellipse (O)", line: "Line (L)", arrow: "Arrow (A)", ruler: "Ruler (M)", pen: "Pen (P)" },
    weights: ["1 px (hairline)", "Thin", "Medium", "Thick"],
    undo: "Undo", redo: "Redo", remove: "Delete selection", zoomIn: "Zoom in (+)", zoomOut: "Zoom out (-)", zoomFit: "Fit to window (0)",
    labelPlaceholder: "Note (optional)",
    save: "Save version",
    done: "Done",
    hint: "Click near a shape to select it, double-click a tool to keep drawing, arrow keys move by 1 px (Option/Alt resizes). Each save adds a version; the original and earlier versions are kept. Only people who have this edit link can save annotations.",
    messages: {
      text: "Text", original: "Original image (no annotations)",
      discard: "You have unsaved annotations. Discard them and switch?",
      saved: "Saved as version {n}.", copy: "Copy link", copied: "Copied",
      saveFailed: "Could not save. Please try again in a little while.",
      loadFailed: "Could not load this version.",
      tooMany: "No more annotations can be added.",
      errors: { 401: "The password session has expired. Please reload the page.", 403: "This link cannot save. Open the edit link instead.", 404: "This link was deleted or has expired.",
        409: "This image has reached the limit of 50 versions.", 413: "There are too many annotations to save.",
        429: "Too many saves in a short time. Please wait a moment and try again.", 503: "The server is busy. Please try again later." },
    },
    report: "Report this image",
    reasons: [["personal", "Contains personal information"], ["illegal", "Illegal or harmful content"], ["copyright", "Copyright infringement"], ["other", "Other"]],
    detail: "Details (optional)",
    send: "Send report",
    footer: "Revvy — annotate and share screenshots on your Mac",
    termsLink: "Terms",
    contactLink: "Removal requests & contact",
  },
} as const;

/** HTML に埋める値は必ずここを通す。ID は形式を確かめてあるが、念のため。 */
export function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** フッターの「Revvy を入手」の行き先。フォークして運営するときは書き換える。 */
const APP_URL = "https://github.com/nishiyuki0501-wanto/revvy";

const style = `
  :root { color-scheme: light dark; --fg: #16201c; --muted: #5d6964; --bg: #f3f5f4; --stage: #e6ebe9; --card: #fff; --line: #d3dbd7;
    --accent: #0b7d5f; --on-accent: #fff; --link: #0b7458; --shadow: 0 1px 2px rgba(16,32,26,.08), 0 12px 32px rgba(16,32,26,.14); }
  @media (prefers-color-scheme: dark) { :root { --fg: #ecf2ef; --muted: #98a6a0; --bg: #111615; --stage: #0b0e0d; --card: #19201d; --line: #2a3430;
    --accent: #2bb38c; --on-accent: #04150f; --link: #56d3ae; --shadow: 0 1px 2px rgba(0,0,0,.5), 0 12px 32px rgba(0,0,0,.55); } }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
  a { color: var(--link); }
  :focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; padding: 10px 20px;
    background: var(--card); border-bottom: 1px solid var(--line); }
  .brand { display: inline-flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 650; color: var(--fg); text-decoration: none; }
  .brand img { display: block; }
  .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .chip { font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; white-space: nowrap; }
  .btn { display: inline-block; font: inherit; font-size: 13px; font-weight: 600; line-height: 1.3; padding: 7px 14px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--card); color: var(--fg); text-decoration: none; cursor: pointer; white-space: nowrap; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .btn:hover { filter: brightness(.95); }
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  /* 画像のクリックで拡大を切り替える。スクリプトは使わない（CSP で止めている）ので、見えないチェックボックスで状態を持つ */
  .vh { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .stage { flex: 1; display: flex; min-width: 0; overflow: auto; padding: 24px; background: var(--stage); }
  [hidden] { display: none !important; }
  .canvas { position: relative; margin: auto; line-height: 0; }
  .shot { display: block; cursor: zoom-in; }
  /* 書き込み（/editor.js が足す）。見るだけのときは画像のクリック（拡大）を邪魔しない */
  .ink { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
  .ink.on { pointer-events: auto; touch-action: none; cursor: crosshair; }
  .ink.on.tool-select { cursor: default; }
  .ink.on.tool-text { cursor: text; }
  .ink [data-i], .ink .handle { pointer-events: none; }
  .field { position: absolute; width: 14em; min-height: 1.4em; margin: 0; padding: 0 3px; border: 1px dashed #0b7d5f; border-radius: 3px;
    background: rgba(255,255,255,.88); font-weight: 600; line-height: 1.3; resize: none; overflow: hidden; }
  .tools { display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; padding: 8px 20px; background: var(--card); border-bottom: 1px solid var(--line); }
  .group { display: flex; align-items: center; gap: 2px; }
  .tool { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 7px; background: none; color: var(--fg); cursor: pointer; }
  .tool:hover { background: var(--stage); }
  .tool[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); }
  .tool[data-locked] { box-shadow: 0 0 0 2px var(--card), 0 0 0 4px var(--accent); }
  .tool svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .swatch { width: 22px; height: 22px; margin: 0 2px; padding: 0; border: 2px solid var(--card); border-radius: 50%; box-shadow: 0 0 0 1px var(--line); cursor: pointer; }
  .swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--fg); }
  .sep { width: 1px; height: 22px; background: var(--line); }
  .warn { color: #c62828; font-weight: 600; }
  .zoomlevel { min-width: 4.2em; height: 32px; padding: 0 6px; border: 0; border-radius: 7px; background: none; color: var(--fg); font: inherit; font-size: 12.5px; font-variant-numeric: tabular-nums; cursor: pointer; }
  .zoomlevel:hover { background: var(--stage); }
  .readout { position: fixed; left: 16px; bottom: 16px; z-index: 4; padding: 5px 10px; border-radius: 8px; background: var(--fg); color: var(--bg); opacity: .92;
    font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; box-shadow: var(--shadow); }
  .readout:empty { display: none; }
  /* 拡大して 1px を見る。画像はぼかさず、8 倍からはピクセルの境目を出す */
  body.zoomed .stage { max-height: calc(100vh - 290px); max-height: calc(100dvh - 290px); min-height: 280px; }
  body.editing.zoomed .shot img { max-width: none; max-height: none; border-radius: 0; }
  body.crisp .shot img { image-rendering: pixelated; }
  .pixels { position: absolute; inset: 0; pointer-events: none;
    background-image: linear-gradient(to right, rgba(128,128,128,.45) 1px, transparent 1px), linear-gradient(to bottom, rgba(128,128,128,.45) 1px, transparent 1px); }
  .grow { flex: 1; }
  .tools input { width: 7em; padding: 6px 10px; }
  .bar select { width: auto; max-width: 16em; }
  .hint { flex-basis: 100%; margin: 0; color: var(--muted); font-size: 12px; }
  button:disabled { opacity: .4; cursor: default; }
  .toast { position: fixed; left: 50%; bottom: 24px; z-index: 5; transform: translateX(-50%); display: flex; align-items: center; gap: 12px;
    max-width: calc(100vw - 32px); padding: 10px 14px; border-radius: 10px; background: var(--fg); color: var(--bg); font-size: 13px; box-shadow: var(--shadow); }
  body.editing .shot { cursor: default; }
  body.editing .shot img { max-height: calc(100vh - 320px); max-height: calc(100dvh - 320px); }
  body.editing #zoom:checked ~ .stage img { max-height: none; }
  .shot img { display: block; width: auto; height: auto; max-width: calc(100vw - 48px);
    max-height: calc(100vh - 230px); max-height: calc(100dvh - 230px); border-radius: 6px; background: var(--card); box-shadow: var(--shadow); }
  #zoom:checked ~ .stage { max-height: calc(100vh - 130px); max-height: calc(100dvh - 130px); }
  #zoom:checked ~ .stage .shot { cursor: zoom-out; }
  #zoom:checked ~ .stage img { max-width: none; max-height: none; }
  #zoom:focus-visible ~ .stage img { outline: 2px solid var(--link); outline-offset: 3px; }
  .info { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px 24px; flex-wrap: wrap; padding: 12px 20px 4px;
    color: var(--muted); font-size: 12.5px; }
  .info p { margin: 0; }
  summary { cursor: pointer; }
  form { display: grid; gap: 8px; width: min(440px, calc(100vw - 40px)); margin-top: 10px; }
  select, textarea, input { font: inherit; width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
  form .btn { justify-self: start; }
  .doc { width: 100%; max-width: 760px; margin: 0 auto; padding: 36px 20px 28px; }
  .doc h1 { font-size: 22px; line-height: 1.35; margin: 0 0 14px; }
  .doc h2 { font-size: 15px; margin: 28px 0 6px; }
  .doc ul { padding-left: 1.4em; }
  .doc .meta { color: var(--muted); font-size: 12.5px; }
  footer { padding: 14px 20px 22px; color: var(--muted); font-size: 12px; }
  @media (max-width: 600px) {
    .bar, .tools, .info, footer { padding-left: 14px; padding-right: 14px; }
    .stage { flex: none; padding: 12px; }
    .shot img { max-width: calc(100vw - 24px); }
  }
`;

function page(lang: Lang, title: string, head: string, main: string, actions = ""): string {
  const t = strings[lang];
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="same-origin">
<title>${escapeHTML(title)}</title>
<link rel="icon" type="image/png" href="/icon.png">
${head}
<style>${style}</style>
</head>
<body>
<header class="bar"><a class="brand" href="/"><img src="/icon.png" width="26" height="26" alt="">Revvy</a>${actions ? `<div class="actions">${actions}</div>` : ""}</header>
<main>${main}</main>
<footer>${escapeHTML(t.footer)} · <a href="${APP_URL}" rel="noopener noreferrer">${escapeHTML(t.getApp)}</a> · <a href="/terms">${escapeHTML(t.termsLink)}</a> · <a href="/contact">${escapeHTML(t.contactLink)}</a></footer>
</body>
</html>`;
}

/** 書き込みの色（/editor.js の初期値は先頭の赤） */
const COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#0090ff", "#111111", "#ffffff"] as const;

/** ツールバーのアイコン（18×18、線で描く） */
const ICONS = {
  select: '<path d="M4 2.5l9 6-4 1 2.5 4.5-1.8 1L7.2 10.5 4 13z"/>',
  text: '<path d="M4 4.5V3h10v1.5M9 3v12M7 15h4"/>',
  rect: '<rect x="3" y="4" width="12" height="10" rx="1"/>',
  ellipse: '<ellipse cx="9" cy="9" rx="6.5" ry="5.5"/>',
  line: '<path d="M3.5 14.5l11-11"/>',
  arrow: '<path d="M3.5 14.5l11-11M8.5 3.5h6v6"/>',
  ruler: '<path d="M3 9h12M3 5.5v7M15 5.5v7M7 9v-2M11 9v-2"/>',
  pen: '<path d="M3 13c2.5-6 4.5 3 6.5-2s3-6 5.5-3"/>',
  weight0: '<path d="M3 9h12" stroke-width="1" stroke-dasharray="1.5 2"/>',
  weight1: '<path d="M3 9h12" stroke-width="1"/>',
  weight2: '<path d="M3 9h12" stroke-width="2.5"/>',
  weight4: '<path d="M3 9h12" stroke-width="4.5"/>',
  undo: '<path d="M6.5 4L3 7.5 6.5 11M3.5 7.5H11a4 4 0 010 8H8"/>',
  redo: '<path d="M11.5 4L15 7.5 11.5 11M14.5 7.5H7a4 4 0 000 8h3"/>',
  remove: '<path d="M3.5 5h11M7 5V3.5h4V5M5 5l.7 10h6.6L13 5M7.6 8v4.5M10.4 8v4.5"/>',
  zoom: '<circle cx="8" cy="8" r="4.5"/><path d="M11.5 11.5L15 15M6 8h4M8 6v4"/>',
  zoomout: '<circle cx="8" cy="8" r="4.5"/><path d="M11.5 11.5L15 15M6 8h4"/>',
} as const;

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

const DAY_MS = 86_400_000;

export function renderViewer(input: {
  lang: Lang; id: string; imageURL: string; pageURL: string; reportURL: string; scriptURL: string; expiresAt: number | null;
  createdAt: number | null; size: number; contentType: string; now: number; locked: boolean;
}): string {
  const t = strings[input.lang];
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const expiry = input.expiresAt === null ? t.forever : t.expires(day(input.expiresAt) + " (UTC)");
  const chip = input.expiresAt === null ? t.noExpiry : t.daysLeft(Math.max(1, Math.ceil((input.expiresAt - input.now) / DAY_MS)));
  const isPNG = input.contentType === "image/png";
  const facts = [
    input.createdAt === null ? null : t.shared(day(input.createdAt)),
    isPNG ? "PNG" : "JPEG",
    formatBytes(input.size),
    expiry,
  ].filter((v): v is string => v !== null).join(" · ");
  const fileName = `revvy-${day(input.createdAt ?? input.now)}.${isPNG ? "png" : "jpg"}`;
  const image = escapeHTML(input.imageURL);
  // パスワード付きのリンクは、プレビュー用の画像の URL を出さない
  const head = input.locked ? "" : [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Revvy">`,
    `<meta property="og:title" content="${escapeHTML(t.title)}">`,
    `<meta property="og:url" content="${escapeHTML(input.pageURL)}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="${image}">`,
  ].join("\n");
  // 編集とバージョンの切り替えは /editor.js が動いたときだけ出す（スクリプトなしでも、元の画像は見られる）
  const actions = (input.locked ? `<span class="chip">${escapeHTML(t.lockedChip)}</span>` : "") + `<span class="chip">${escapeHTML(chip)}</span>`
    + `<select class="btn" id="versions" aria-label="${escapeHTML(t.versions)}" hidden></select>`
    + `<button class="btn" type="button" id="edit" hidden>${escapeHTML(t.edit)}</button>`
    + `<a class="btn" href="${image}">${escapeHTML(t.open)}</a>`
    + `<a class="btn primary" id="download" href="${image}" download="${fileName}">${escapeHTML(t.download)}</a>`;
  const toolButton = (name: keyof typeof ICONS, label: string, attrs: string) =>
    `<button class="tool" type="button" ${attrs} title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}"><svg viewBox="0 0 18 18" aria-hidden="true">${ICONS[name]}</svg></button>`;
  const toolNames = ["select", "text", "rect", "ellipse", "line", "arrow", "ruler", "pen"] as const;
  const toolbar = `<div class="tools" id="tools" hidden data-id="${escapeHTML(input.id)}" data-messages="${escapeHTML(JSON.stringify(t.messages))}">
<div class="group">${toolNames.map((name) => toolButton(name, t.tools[name], `data-tool="${name}" aria-pressed="false"`)).join("")}</div><span class="sep"></span>
<div class="group">${COLORS.map((c) => `<button class="swatch" type="button" data-color="${c}" aria-pressed="false" aria-label="${c}" style="background:${c}"></button>`).join("")}</div><span class="sep"></span>
<div class="group">${([0, 1, 2, 4] as const).map((w, i) => toolButton(`weight${w}`, t.weights[i], `data-weight="${w}" aria-pressed="false"`)).join("")}</div><span class="sep"></span>
<div class="group">${toolButton("undo", t.undo, 'id="undo"')}${toolButton("redo", t.redo, 'id="redo"')}${toolButton("remove", t.remove, 'id="del"')}</div><span class="sep"></span>
<div class="group">${toolButton("zoomout", t.zoomOut, 'id="zoomout"')}<button type="button" class="zoomlevel" id="zoomlevel" title="${escapeHTML(t.zoomFit)}" aria-label="${escapeHTML(t.zoomFit)}">100%</button>${toolButton("zoom", t.zoomIn, 'id="zoomin"')}</div>
<output class="readout" id="readout" aria-live="off"></output>
<span class="grow"></span>
<input id="vlabel" type="text" maxlength="60" placeholder="${escapeHTML(t.labelPlaceholder)}" aria-label="${escapeHTML(t.labelPlaceholder)}">
<button class="btn primary" type="button" id="save" disabled>${escapeHTML(t.save)}</button>
<button class="btn" type="button" id="done">${escapeHTML(t.done)}</button>
<p class="hint">${escapeHTML(t.hint)}</p>
</div>`;
  const reasons = t.reasons.map(([value, label]) => `<option value="${value}">${escapeHTML(label)}</option>`).join("");
  const main = `
<input class="vh" type="checkbox" id="zoom" aria-label="${escapeHTML(t.zoom)}">
${toolbar}
<div class="stage"><div class="canvas" id="canvas"><label class="shot" for="zoom" title="${escapeHTML(t.zoom)}"><img id="shot" src="${image}" alt="${escapeHTML(t.title)}"></label></div></div>
<div class="info"><p>${escapeHTML(facts)}</p>
<details><summary>${escapeHTML(t.report)}</summary>
<form method="post" action="${escapeHTML(input.reportURL)}">
<select name="reason" required>${reasons}</select>
<textarea name="detail" rows="3" maxlength="1000" placeholder="${escapeHTML(t.detail)}"></textarea>
<button class="btn" type="submit">${escapeHTML(t.send)}</button>
</form></details></div>
<div class="toast" id="toast" role="status" hidden></div>
<script src="${escapeHTML(input.scriptURL)}" defer></script>`;
  return page(input.lang, t.title, head, main, actions);
}

/** パスワード付きのリンクの入口。画像の情報は何も出さない。 */
export function renderLocked(lang: Lang, id: string, problem: "wrong" | "busy" | null, scriptURL: string): string {
  const t = strings[lang].locked;
  const note = problem ? `<p class="warn" role="alert">${escapeHTML(t[problem])}</p>` : "";
  return page(lang, t.title, "", `<div class="doc"><h1>${escapeHTML(t.title)}</h1><p>${escapeHTML(t.lead)}</p>${note}
<form method="post" action="/${escapeHTML(id)}/unlock">
<input name="password" type="password" maxlength="128" required autofocus autocomplete="off" placeholder="${escapeHTML(t.placeholder)}" aria-label="${escapeHTML(t.placeholder)}">
<button class="btn primary" type="submit">${escapeHTML(t.submit)}</button>
</form></div><script src="${escapeHTML(scriptURL)}" defer></script>`);
}

export function renderMessagePage(lang: Lang, title: string, message: string): string {
  return page(lang, title, "", `<div class="doc"><h1>${escapeHTML(title)}</h1><p>${escapeHTML(message)}</p></div>`);
}

const terms = {
  ja: {
    title: "Revvy 共有リンクの利用規約",
    sections: [
      ["このサービスについて", ["Revvy（Mac のスクリーンショットアプリ）の「リンクを作成してコピー」で上げた画像を、URL を知っている人に表示するサービスです。Revvy の開発者が運営しています。画像を上げた時点で、この規約に同意したものとします。"]],
      ["上げてはいけないもの", ["法令に違反する画像（児童の性的な画像を含む）", "他人の著作権・商標・肖像・プライバシーなどの権利を侵害する画像", "他人の個人情報や秘密の情報を、本人の同意なく公開する画像", "詐欺、なりすまし、嫌がらせ、マルウェアの配布に使う画像", "スクリーンショットの共有以外の目的（ファイル置き場、大量の自動アップロードなど）での利用"]],
      ["削除と利用の制限", ["規約に反する、またはその疑いがある画像は、予告なく削除することがあります。", "悪用を防ぐため、アップロードの回数や容量を制限しています。制限は予告なく変えることがあります。"]],
      ["保存期間", ["30日のリンクは、期限が過ぎると表示されなくなり、削除されます。", "無期限のリンクは、作った Mac から削除するまで残ります。ただし、規約に反する場合やサービスを終了する場合は削除されます。", "大切な画像は、必ず手元にも保存してください。"]],
      ["URL を知っている人は誰でも見られます", ["パスワードを付けていないリンクは、URL を知っている人なら誰でも見られます。見られて困る情報が写っていないか、共有する前に確認してください。漏れると困る画像には、アプリの設定でパスワードと短い保存期間を付けてください。", "編集用リンクを持っている人は、共有ページで文字や図形などの書き込みを足して、新しいバージョンとして保存できます。元の画像と前のバージョンは書き換わりません。", "書き込みにも「上げてはいけないもの」の決まりが当てはまります。違反する書き込みは、予告なく削除することがあります。"]],
      ["免責", ["このサービスは無償で、現状のまま提供します。画像の消失、サービスの中断・終了、共有した画像が第三者に見られたことによる損害について、法令で認められる範囲で責任を負いません。"]],
      ["規約の変更", ["この規約は変更することがあります。変更後の規約はこのページに掲載します。"]],
    ],
    contact: "削除依頼やお問い合わせは、こちらのフォームからお送りください。",
  },
  en: {
    title: "Terms for Revvy share links",
    sections: [
      ["About this service", ["This service shows images uploaded with “Create and Copy Link” in Revvy, a screenshot app for Mac, to anyone who has the URL. It is operated by Revvy's developer. By uploading an image you agree to these terms."]],
      ["What you must not upload", ["Images that violate the law, including sexual images of children", "Images that infringe someone else's copyright, trademark, likeness, privacy or other rights", "Images that expose someone's personal or confidential information without consent", "Images used for fraud, impersonation, harassment or distributing malware", "Use for anything other than sharing screenshots, such as file hosting or bulk automated uploads"]],
      ["Removal and limits", ["Images that violate, or appear to violate, these terms may be removed without notice.", "Uploads are limited in number and size to prevent abuse. The limits may change without notice."]],
      ["Retention", ["A 30-day link stops being shown after it expires and is deleted.", "A no-expiry link stays until it is deleted from the Mac that created it, but it will be deleted if it violates these terms or if the service ends.", "Always keep your own copy of important images."]],
      ["Anyone with the URL can view the image", ["A link without a password can be viewed by anyone who has the URL. Check that nothing sensitive is visible before you share. For images that must not leak, add a password and a short retention period in the app's settings.", "People who have the edit link can add annotations such as text and shapes on the share page and save them as a new version. The original image and earlier versions are never overwritten.", "The rules in “What you must not upload” also apply to annotations. Annotations that violate them may be removed without notice."]],
      ["Disclaimer", ["The service is free and provided as is. To the extent permitted by law, we are not liable for loss of images, interruption or termination of the service, or damage caused by a shared image being seen by others."]],
      ["Changes", ["These terms may change. The current version is always on this page."]],
    ],
    contact: "Send removal requests and questions with this form.",
  },
} as const;

export function renderTerms(lang: Lang): string {
  const t = terms[lang];
  const body = t.sections.map(([heading, items]) =>
    `<h2>${escapeHTML(heading)}</h2>` + (items.length === 1 ? `<p>${escapeHTML(items[0])}</p>` : `<ul>${items.map((i) => `<li>${escapeHTML(i)}</li>`).join("")}</ul>`)).join("");
  return page(lang, t.title, "", `<div class="doc"><h1>${escapeHTML(t.title)}</h1>${body}<p><a href="/contact">${escapeHTML(t.contact)}</a></p></div>`);
}

const contactStrings = {
  ja: {
    title: "削除依頼・お問い合わせ",
    lead: "ここから送った内容は公開されません。画像の削除を依頼するときは、その画像の URL を書いてください。",
    topics: [["removal", "画像を削除してほしい"], ["rights", "権利の侵害を知らせたい"], ["other", "その他"]],
    link: "対象の URL（任意）", message: "内容", reply: "返信先（任意。メールアドレスなど）", send: "送信する",
    note: "返信先を書かなかった場合、こちらから返事はできません。",
  },
  en: {
    title: "Removal requests & contact",
    lead: "What you send here is not public. To ask for an image to be removed, include its URL.",
    topics: [["removal", "Please remove an image"], ["rights", "Report a rights violation"], ["other", "Other"]],
    link: "URL of the image (optional)", message: "Message", reply: "Where to reply (optional, e.g. email)", send: "Send",
    note: "If you leave the reply field empty, we cannot answer you.",
  },
} as const;

export function renderContact(lang: Lang): string {
  const t = contactStrings[lang];
  const topics = t.topics.map(([value, label]) => `<option value="${value}">${escapeHTML(label)}</option>`).join("");
  return page(lang, t.title, "", `<div class="doc"><h1>${escapeHTML(t.title)}</h1><p>${escapeHTML(t.lead)}</p>
<form method="post" action="/contact">
<select name="topic" required>${topics}</select>
<input name="link" type="text" maxlength="300" placeholder="${escapeHTML(t.link)}">
<textarea name="message" rows="6" maxlength="2000" required placeholder="${escapeHTML(t.message)}"></textarea>
<input name="reply" type="text" maxlength="200" placeholder="${escapeHTML(t.reply)}">
<button class="btn primary" type="submit">${escapeHTML(t.send)}</button>
</form><p class="meta">${escapeHTML(t.note)}</p></div>`);
}
