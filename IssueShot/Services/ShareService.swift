import CryptoKit
import Foundation
import Security

/// 共有リンクの保存期間。既定は 30 日。サーバー側（cloud/）の retention と同じ値を使う。
enum ShareRetention: String, CaseIterable, Identifiable, Codable, Sendable {
    case thirtyDays = "30d"
    case forever

    var id: String { rawValue }

    var title: String {
        switch self {
        case .thirtyDays: String(localized: "30日")
        case .forever: String(localized: "無期限")
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
        if let existing = store.read(), isValid(existing) { return existing }
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

    /// 共有リンクの ID の形（サーバーの ID_PATTERN と同じ）
    static func isValidID(_ id: String) -> Bool {
        id.count == 22 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// 親鍵から、このサーバー用の鍵を作って使う。
    static func make(baseURL: URL, masterKey: String, session: URLSession = .shared) -> ShareClient {
        ShareClient(baseURL: baseURL, deviceKey: ShareDeviceKey.key(for: baseURL, master: masterKey), session: session)
    }

    private struct UploadResponse: Decodable {
        let id: String
        let url: URL
        let expiresAt: String?
    }

    private struct ErrorResponse: Decodable {
        let error: String?
    }

    func upload(_ data: Data, contentType: String = "image/jpeg", retention: ShareRetention, now: Date = Date()) async throws -> CloudShare {
        var components = URLComponents(url: baseURL.appending(path: "api/v1/shots"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "retention", value: retention.rawValue)]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(deviceKey)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 60
        let (body, response) = try await session.upload(for: request, from: data, delegate: RefuseRedirects())
        try check(response, body: body, expected: 201)
        let decoded = try JSONDecoder().decode(UploadResponse.self, from: body)
        // 別のサーバーを指すリンクや、形の違う ID は受け取らない（削除のときにそこへ鍵を送ることになるため）
        guard Self.isValidID(decoded.id), decoded.url.lastPathComponent == decoded.id,
              ShareConfig.server(of: decoded.url)?.absoluteString == ShareConfig.validated(baseURL.absoluteString)?.absoluteString else {
            throw URLError(.badServerResponse)
        }
        return CloudShare(id: decoded.id, url: decoded.url, createdAt: now, expiresAt: decoded.expiresAt.flatMap(Self.parseDate))
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
