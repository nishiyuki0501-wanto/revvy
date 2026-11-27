export type Lang = "ja" | "en";

const strings = {
  ja: {
    title: "Revvy で共有されたスクリーンショット",
    expires: (date: string) => `${date} に自動で削除されます`,
    forever: "保存期間: 無期限（共有した人が削除するまで）",
    open: "画像だけを開く",
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

const style = `
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #f5f5f7; --card: #fff; --line: #d2d2d7; --accent: #0f9e78; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #161617; --card: #1f1f21; --line: #3a3a3c; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 1200px; margin: 0 auto; padding: 24px 20px 40px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0; }
  .meta { color: var(--muted); font-size: 12.5px; }
  figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px; text-align: center; }
  figure img { max-width: 100%; height: auto; display: block; margin: 0 auto; border-radius: 4px; }
  a { color: var(--accent); }
  details { margin-top: 18px; color: var(--muted); font-size: 12.5px; }
  form { display: grid; gap: 8px; max-width: 420px; margin-top: 10px; }
  h2 { font-size: 14px; margin: 22px 0 6px; }
  article { max-width: 720px; }
  select, textarea, button, input { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
  button { cursor: pointer; }
  footer { margin-top: 28px; color: var(--muted); font-size: 12px; }
`;

function page(lang: Lang, title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="same-origin">
<title>${escapeHTML(title)}</title>
${head}
<style>${style}</style>
</head>
<body><main>${body}<footer>${escapeHTML(strings[lang].footer)} · <a href="/terms">${escapeHTML(strings[lang].termsLink)}</a> · <a href="/contact">${escapeHTML(strings[lang].contactLink)}</a></footer></main></body>
</html>`;
}

export function renderViewer(input: {
  lang: Lang; id: string; imageURL: string; pageURL: string; reportURL: string; expiresAt: number | null;
}): string {
  const t = strings[input.lang];
  const expiry = input.expiresAt === null
    ? t.forever
    : t.expires(new Date(input.expiresAt).toISOString().slice(0, 10) + " (UTC)");
  const image = escapeHTML(input.imageURL);
  const head = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHTML(t.title)}">`,
    `<meta property="og:url" content="${escapeHTML(input.pageURL)}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="${image}">`,
  ].join("\n");
  const reasons = t.reasons.map(([value, label]) => `<option value="${value}">${escapeHTML(label)}</option>`).join("");
  const body = `
<header><h1>${escapeHTML(t.title)}</h1><span class="meta">${escapeHTML(expiry)}</span></header>
<figure><a href="${image}"><img src="${image}" alt="${escapeHTML(t.title)}"></a></figure>
<p class="meta"><a href="${image}">${escapeHTML(t.open)}</a></p>
<details><summary>${escapeHTML(t.report)}</summary>
<form method="post" action="${escapeHTML(input.reportURL)}">
<select name="reason" required>${reasons}</select>
<textarea name="detail" rows="3" maxlength="1000" placeholder="${escapeHTML(t.detail)}"></textarea>
<button type="submit">${escapeHTML(t.send)}</button>
</form></details>`;
  return page(input.lang, t.title, head, body);
}

export function renderMessagePage(lang: Lang, title: string, message: string): string {
  return page(lang, title, "", `<header><h1>${escapeHTML(title)}</h1></header><p>${escapeHTML(message)}</p>`);
}

const terms = {
  ja: {
    title: "Revvy 共有リンクの利用規約",
    sections: [
      ["このサービスについて", ["Revvy（Mac のスクリーンショットアプリ）の「リンクを作成してコピー」で上げた画像を、URL を知っている人に表示するサービスです。Revvy の開発者が運営しています。画像を上げた時点で、この規約に同意したものとします。"]],
      ["上げてはいけないもの", ["法令に違反する画像（児童の性的な画像を含む）", "他人の著作権・商標・肖像・プライバシーなどの権利を侵害する画像", "他人の個人情報や秘密の情報を、本人の同意なく公開する画像", "詐欺、なりすまし、嫌がらせ、マルウェアの配布に使う画像", "スクリーンショットの共有以外の目的（ファイル置き場、大量の自動アップロードなど）での利用"]],
      ["削除と利用の制限", ["規約に反する、またはその疑いがある画像は、予告なく削除することがあります。", "悪用を防ぐため、アップロードの回数や容量を制限しています。制限は予告なく変えることがあります。"]],
      ["保存期間", ["30日のリンクは、期限が過ぎると表示されなくなり、削除されます。", "無期限のリンクは、作った Mac から削除するまで残ります。ただし、規約に反する場合やサービスを終了する場合は削除されます。", "大切な画像は、必ず手元にも保存してください。"]],
      ["URL を知っている人は誰でも見られます", ["共有した画像にアクセス制限はありません。見られて困る情報が写っていないか、共有する前に確認してください。"]],
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
      ["Anyone with the URL can view the image", ["Shared images have no access control. Check that nothing sensitive is visible before you share."]],
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
  return page(lang, t.title, "", `<header><h1>${escapeHTML(t.title)}</h1></header><article>${body}<p><a href="/contact">${escapeHTML(t.contact)}</a></p></article>`);
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
  return page(lang, t.title, "", `<header><h1>${escapeHTML(t.title)}</h1></header><p>${escapeHTML(t.lead)}</p>
<form method="post" action="/contact">
<select name="topic" required>${topics}</select>
<input name="link" type="text" maxlength="300" placeholder="${escapeHTML(t.link)}">
<textarea name="message" rows="6" maxlength="2000" required placeholder="${escapeHTML(t.message)}"></textarea>
<input name="reply" type="text" maxlength="200" placeholder="${escapeHTML(t.reply)}">
<button type="submit">${escapeHTML(t.send)}</button>
</form><p class="meta">${escapeHTML(t.note)}</p>`);
}
