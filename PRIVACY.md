# Privacy

**English** · [日本語](PRIVACY.ja.md) · [简体中文](PRIVACY.zh-Hans.md) · [한국어](PRIVACY.ko.md)

This document describes how Revvy handles your data in the current source code.

## Summary

- Revvy has no analytics, advertising or crash-reporting SDKs.
- Everything you capture stays on your Mac unless you use **Create and Copy Link** or a GitHub feature.
- **Create and Copy Link** sends the annotated image to Revvy's share server ([details below](#data-sent-to-the-share-server)).
- GitHub features send data only to the GitHub repository you choose.

## Data stored on your Mac

| Data | Where |
| --- | --- |
| Captured images, annotations, notes, recognized text, and a record of the share links you created (ID, URL, edit link, password-protection status, expiry) | `~/Library/Application Support/Revvy/Captures` (inside the app container for sandboxed builds) |
| Settings (shortcuts, ruler unit, panel state, selected repository, etc.) | The app's preferences (`UserDefaults`) |
| GitHub access token, the device key used for sharing, and the link-sharing password (if set) | macOS Keychain (non-synchronizing items; legacy keychains may retain their original accessibility) |

Text recognition (OCR) runs on your Mac with Apple Vision. Images are not uploaded for recognition.

Deleting a capture from the history removes it from your Mac only.

## Screen Recording permission

Revvy asks for Screen Recording permission so it can take screenshots. It captures the screen only when you start a capture (shortcut, floating panel, menu or button). The on-screen ruler does not capture the screen.

## Data sent to the share server

Revvy talks to its share server (run on Cloudflare Workers and R2, and operated by Revvy's developer) only in these cases:

| When | What is sent |
| --- | --- |
| **Create and Copy Link** | The annotated image (JPEG), the retention period you chose (1 day / 7 days / 30 days / no expiry), the device key and, if you set one, the password (the server stores only a hash of it) |
| Deleting a shared link | The ID of the link being deleted and the device key |

- The **device key** is a random number generated on your Mac the first time you share. It is not tied to your name, email address, Apple ID or anything similar. The server stores only its hash (SHA-256), not the key itself, together with the image. It is used so that only the Mac that created a link can delete it, and to prevent bulk uploads in a short time.
- A shared image can be **viewed by anyone who knows the URL**. The URL is an unguessable random ID and is marked to stay out of search engines, but anyone the URL is forwarded to can view the image too.
- On the share page, **people who have the edit link can add annotations (text, shapes, lines, rulers) in the browser and save them** (the normal link is view-only). For a password-protected link, the browser that entered the password keeps a cookie for that link only, for 12 hours (it is not used for tracking). Each save adds a new version; the original image and earlier versions are never overwritten. The server stores only the annotations themselves (positions, colors, text), an optional note and the time of the save. It does not store the IP address or name of the person who saved. Versions are deleted together with the image, or when the image expires.
- A **1-day, 7-day or 30-day** link stops being shown after it expires and is deleted from the server. A **no-expiry** link stays until you delete it from the Mac that created it.
- The IP address is used for rate limiting and daily limits, but the address itself is not stored. To count daily uploads, the server keeps a value derived from the IP address with a secret key and the date (it cannot be turned back into the address and does not link across days), together with counts and sizes, for up to about 2 days. IPv6 addresses are counted per /56 range. Traffic is handled by Cloudflare, whose handling of it is governed by the [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/).
- Reports submitted through **Report this image** on the viewer page (reason, details, country) are stored for review. The reporter's IP address is not stored. Illegal or rights-infringing images may be removed after a report is reviewed.
- **Sensitive information inside images is not removed automatically.** Check before sharing.
- Deleting local history does not delete shared links. Delete the links first.

## Data sent to GitHub

Revvy talks to GitHub (`github.com`, `api.github.com`) only in these cases:

| When | What is sent |
| --- | --- |
| Connecting GitHub | The device-flow request with the app's public Client ID. You approve access in your browser. |
| Loading repositories, labels, assignees | Requests authenticated with your token. |
| **Create Issue** | The annotated image is committed to a branch (default `feedback-assets`) of the repository you selected. The title, comment, labels, assignees and environment details (app version, macOS version, Mac model, display size, capture time, your GitHub username) are sent as well. |

- Images sent to a **public** repository are public. In a **private** repository, GitHub's access permissions apply. If you only create issues in public repositories, you can restrict the requested OAuth scope to `public_repo` in Settings before connecting.
- Revvy masks common sensitive text (tokens, API keys, JWTs, `Authorization`/`Cookie`/`Set-Cookie` headers, credentials in URLs, email addresses) in issue text, but it **does not** remove sensitive information from images. Check the image and text before sharing.
- Deleting local history does not delete images, commits or issues on GitHub. Manage that data on GitHub.
- You can revoke Revvy's access at any time in GitHub under **Settings → Applications → Authorized OAuth Apps**, and sign out in Revvy from the account menu in the sidebar.

GitHub's handling of that data is governed by the [GitHub General Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

## Developer option (direct builds only)

Builds distributed outside the Mac App Store include a developer option that, when you explicitly choose it, reads the token of a logged-in `gh` CLI. Sandboxed builds do not include this option.

## Changes

Changes to this document are tracked in the Git history of this repository.

## Contact

Questions about privacy: open an issue in this repository. To ask for a shared image to be removed, or for anything you do not want to post publicly, use the private form at <https://revvy-share.calm-feather-2cb7.workers.dev/contact> (what you send, including a reply address if you give one, is stored for up to 365 days). The terms for share links are at <https://revvy-share.calm-feather-2cb7.workers.dev/terms>. For anything sensitive, follow [SECURITY.md](SECURITY.md) instead.
