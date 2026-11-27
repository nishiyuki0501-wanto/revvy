import CryptoKit
import Foundation
import Security

/// 共有リンクの保存期間。既定は 30 日。サーバー側（cloud/）の retention と同じ値を使う。
enum ShareRetention: String, CaseIterable, Identifiable, Codable, Sendable {
    case oneDay = "1d"
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case forever

    var id: String { rawValue }

    var title: String {
        switch self {
        case .oneDay: String(localized: "1日")
        case .sevenDays: String(localized: "7日")
        case .thirtyDays: String(localized: "30日")
        case .forever: String(localized: "無期限")
        }
    }

    /// いつ消えるかの説明
    var expiryNotice: String {
        switch self {
        case .oneDay: String(localized: "1日後に自動で削除されます。")
        case .sevenDays: String(localized: "7日後に自動で削除されます。")
        case .thirtyDays: String(localized: "30日後に自動で削除されます。")
        case .forever: String(localized: "削除するまで残ります。")
        }
    }

    /// リンクをコピーしたあとの知らせ
    var copiedStatus: String {
        switch self {
        case .oneDay: String(localized: "リンクをコピーしました（1日後に自動で削除）")
        case .sevenDays: String(localized: "リンクをコピーしました（7日後に自動で削除）")
        case .thirtyDays: String(localized: "リンクをコピーしました（30日後に自動で削除）")
        case .forever: String(localized: "リンクをコピーしました（無期限）")
        }
    }
}

/// クラウドに置いた共有リンク。履歴（SavedCapture）に残して、あとから消せるようにする。
struct CloudShare: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let url: URL
    let createdAt: Date
    /// nil は無期限
    let expiresAt: Date?
    /// ブラウザで書き込みを保存できるリンク（…/<id>#edit=<合言葉>）。0.3.0 で作ったリンクには無い
    var editURL: URL? = nil
    /// パスワード付きで作ったか
    var isProtected: Bool? = nil

    func isExpired(now: Date = Date()) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt <= now
    }
}

/// 共有サーバー（Cloudflare Workers）の場所。
enum ShareConfig {
    /// 公式ビルドの共有サーバー。フォークで配布するときは自分の Worker の URL に変える（cloud/README.md）。
    static let bundledBaseURL = "https://revvy-share.calm-feather-2cb7.workers.dev"

    /// 設定画面での上書き > 同梱値 の順に解決する。HTTPS だけを受け付ける（手元の確認用に localhost は http も可）。
    static func resolveBaseURL(override: String?, bundled: String = bundledBaseURL) -> URL? {
        let trimmed = override?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return validated(trimmed.isEmpty ? bundled : trimmed)
    }

    /// 共有リンク（https://サーバー/<id>）から、それを作ったサーバーの URL を取り出す。
    /// 削除は、いま設定しているサーバーではなく、リンクを作ったサーバーに送る（設定を変えたあとでも消せるように）。
    static func server(of shareURL: URL) -> URL? {
        validated(shareURL.deletingLastPathComponent().absoluteString)
    }

    /// 共有サーバーの URL として使えるか確かめ、比べられる形にそろえる（ホストは小文字、既定のポートは省く、末尾の / は省く）。
    static func validated(_ string: String) -> URL? {
        guard var components = URLComponents(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(), let rawHost = components.host, !rawHost.isEmpty,
              components.query == nil, components.fragment == nil,
              components.user == nil, components.password == nil else { return nil }
        let host = rawHost.lowercased()
        let bareHost = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let isLocal = bareHost == "localhost" || bareHost == "127.0.0.1" || bareHost == "::1"
        guard scheme == "https" || (scheme == "http" && isLocal) else { return nil }
        components.scheme = scheme
        components.host = host
        if (scheme == "https" && components.port == 443) || (scheme == "http" && components.port == 80) { components.port = nil }
        if components.path.hasSuffix("/") { components.path = String(components.path.dropLast()) }
        return components.url
    }
}

/// ログインの代わりに使う、この Mac 専用の鍵。初回の共有で作って Keychain に置く。
/// サーバーは鍵のハッシュだけを持ち、「上げた本人だけが消せる」ことと回数制限に使う。
///
/// Keychain の鍵（親鍵）はそのまま送らない。サーバーごとに HMAC で別の鍵を作って送る。
/// 設定で別のサーバーを指定しても、そのサーバーに本番のリンクを消せる鍵が渡らないようにするため。
enum ShareDeviceKey {
    /// サーバーに送る鍵。親鍵とサーバーの URL から決まる（同じサーバーには毎回同じ鍵）。
    static func key(for server: URL, master: String) -> String {
        let scope = ShareConfig.validated(server.absoluteString)?.absoluteString ?? server.absoluteString
        let mac = HMAC<SHA256>.authenticationCode(for: Data(scope.utf8), using: SymmetricKey(data: Data(master.utf8)))
        return Data(mac).base64URLEncodedString()
    }

    static func loadOrCreate(store: KeychainStore = .shareDeviceKey) throws -> String {
        if let existing = try store.readIfPresent() {
            guard isValid(existing) else { throw KeychainError(status: errSecDecode) }
            return existing
        }
        let key = try generate()
        try store.write(key)
        return key
    }

    static func generate() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return Data(bytes).base64URLEncodedString()
    }

    static func isValid(_ key: String) -> Bool {
        key.count == 43 && key.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

struct ShareError: LocalizedError, Equatable {
    let status: Int
    let code: String?

    var errorDescription: String? {
        switch status {
        case _ where code == "password_unsupported": String(localized: "この共有サーバーはパスワードに対応していないため、リンクを作りませんでした。")
        case 400 where code == "invalid_password": String(localized: "パスワードは 8〜128 文字で入力してください。")
        case 401: String(localized: "共有サーバーがこの Mac の鍵を受け付けませんでした。")
        case 403: String(localized: "この Mac で作ったリンクではないため、削除できません。")
        case 413: String(localized: "画像が大きすぎて共有できません。")
        case 415: String(localized: "この形式の画像は共有できません。")
        case 429 where code == "daily_quota": String(localized: "今日共有できる上限に達しました。明日もう一度お試しください。")
        case 429: String(localized: "短い時間に共有しすぎています。1 分ほど待ってから、もう一度お試しください。")
        case 503: String(localized: "共有サーバーが混み合っています。しばらくしてから、もう一度お試しください。")
        default: String(localized: "共有サーバーでエラーが発生しました（HTTP \(status)）。")
        }
    }
}

/// cloud/src/index.ts の API を呼ぶ。
struct ShareClient: Sendable {
    let baseURL: URL
    /// このサーバー用の鍵（ShareDeviceKey.key(for:master:)）
    let deviceKey: String
    var session: URLSession = .shared

    /// 共有リンクの ID の形（サーバーの ID_PATTERN と同じ）。43 文字が今の形で、22 文字は 0.3.0 で作ったリンク
    static func isValidID(_ id: String) -> Bool {
        (id.count == 43 || id.count == 22) && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// 親鍵から、このサーバー用の鍵を作って使う。
    static func make(baseURL: URL, masterKey: String, session: URLSession = .shared) -> ShareClient {
        ShareClient(baseURL: baseURL, deviceKey: ShareDeviceKey.key(for: baseURL, master: masterKey), session: session)
    }

    private struct UploadResponse: Decodable {
        let id: String
        let url: URL
        let expiresAt: String?
        let editURL: URL?
        let protected: Bool?
    }

    /// サーバーと同じ決まり（8〜128 文字、制御文字なし）
    static func isValidPassword(_ password: String) -> Bool {
        (8...128).contains(password.unicodeScalars.count) && !password.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }

    /// 編集用リンクは、共有リンクと同じ場所を指し、# 以降に合言葉が付いたものだけを受け取る
    static func validEditURL(_ url: URL?, for shareURL: URL) -> URL? {
        guard let url, let fragment = url.fragment, fragment.hasPrefix("edit="), ShareDeviceKey.isValid(String(fragment.dropFirst(5))),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        components.fragment = nil
        return components.url == shareURL ? url : nil
    }

    private struct ErrorResponse: Decodable {
        let error: String?
    }

    /// 人に伝えやすく、推測されにくいパスワード（紛らわしい文字を除いた 16 文字、約 80 ビット）
    static func generatePassword() -> String {
        let alphabet = Array("abcdefghijkmnpqrstuvwxyz23456789")
        var generator = SystemRandomNumberGenerator()
        let letters = (0..<16).map { _ in alphabet[Int.random(in: 0..<alphabet.count, using: &generator)] }
        return stride(from: 0, to: 16, by: 4).map { String(letters[$0..<$0 + 4]) }.joined(separator: "-")
    }

    private struct Capabilities: Decodable {
        let password: Bool?
    }

    /// 画像を送る前に、このサーバーでパスワード付きのリンクを作れるかを確かめる（作れないサーバーに、画像を置いてしまわないように）
    func supportsPasswords() async -> Bool {
        var request = URLRequest(url: baseURL.appending(path: "api/v1/capabilities"))
        request.timeoutInterval = 20
        guard let (body, response) = try? await session.data(for: request, delegate: RefuseRedirects()),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
        return (try? JSONDecoder().decode(Capabilities.self, from: body))?.password == true
    }

    func upload(_ data: Data, contentType: String = "image/jpeg", retention: ShareRetention, password: String? = nil, now: Date = Date()) async throws -> CloudShare {
        if let password, !password.isEmpty, !(await supportsPasswords()) {
            throw ShareError(status: 0, code: "password_unsupported")
        }
        var components = URLComponents(url: baseURL.appending(path: "api/v1/shots"), resolvingAgainstBaseURL: false)!
        // id=long で 43 文字（256 ビット）の ID を頼む。対応していない古いサーバーは 22 文字を返す
        components.queryItems = [URLQueryItem(name: "retention", value: retention.rawValue), URLQueryItem(name: "id", value: "long")]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(deviceKey)", forHTTPHeaderField: "Authorization")
        // パスワードは UTF-8 を base64url にして送る（ヘッダーに日本語をそのまま入れられないため）。サーバーはハッシュだけを持つ。
        // ヘッダー名は、サーバーの運営者のログ（wrangler tail）で値が伏せ字になる名前にしている
        if let password, !password.isEmpty {
            request.setValue(Data(password.utf8).base64URLEncodedString(), forHTTPHeaderField: "X-Share-Secret")
        }
        request.timeoutInterval = 60
        let (body, response) = try await session.upload(for: request, from: data, delegate: RefuseRedirects())
        try check(response, body: body, expected: 201)
        let decoded = try JSONDecoder().decode(UploadResponse.self, from: body)
        // 別のサーバーを指すリンクや、形の違う ID は受け取らない（削除のときにそこへ鍵を送ることになるため）
        guard Self.isValidID(decoded.id), decoded.url.lastPathComponent == decoded.id,
              ShareConfig.server(of: decoded.url)?.absoluteString == ShareConfig.validated(baseURL.absoluteString)?.absoluteString else {
            throw URLError(.badServerResponse)
        }
        // パスワードを頼んだのに付かなかった（対応していないサーバー）ときは、誰でも見られるリンクを残さない
        if let password, !password.isEmpty, decoded.protected != true {
            try? await delete(id: decoded.id)
            throw ShareError(status: 0, code: "password_unsupported")
        }
        return CloudShare(id: decoded.id, url: decoded.url, createdAt: now, expiresAt: decoded.expiresAt.flatMap(Self.parseDate),
                          editURL: Self.validEditURL(decoded.editURL, for: decoded.url), isProtected: decoded.protected)
    }

    /// リンクを作ったサーバーに向けたクライアント。
    static func forShare(_ share: CloudShare, masterKey: String, session: URLSession = .shared) -> ShareClient? {
        guard isValidID(share.id), let server = ShareConfig.server(of: share.url) else { return nil }
        return make(baseURL: server, masterKey: masterKey, session: session)
    }

    /// API ではリダイレクトに従わない（転送先が 204 を返しても、消えたことにしない）
    private final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest) async -> URLRequest? { nil }
    }

    /// すでに消えている（期限切れ・削除済み）リンクは、消せたものとして扱う。
    func delete(id: String) async throws {
        guard Self.isValidID(id) else { throw URLError(.badURL) }
        var request = URLRequest(url: baseURL.appending(path: "api/v1/shots/\(id)"))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(deviceKey)", forHTTPHeaderField: "Authorization")
        let (body, response) = try await session.data(for: request, delegate: RefuseRedirects())
        if (response as? HTTPURLResponse)?.statusCode == 404 { return }
        try check(response, body: body, expected: 204)
    }

    private func check(_ response: URLResponse, body: Data, expected: Int) throws {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard http.statusCode != expected else { return }
        throw ShareError(status: http.statusCode, code: (try? JSONDecoder().decode(ErrorResponse.self, from: body))?.error)
    }

    static func parseDate(_ string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }
}
