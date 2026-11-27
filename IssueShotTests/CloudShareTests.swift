import CoreGraphics
import Foundation
import Testing
@testable import IssueShot

/// 共有サーバーの代わり。端末キーで応答を切り替える（テストは並行に走るので、共有の状態を持たない）。
private final class CloudShareStub: URLProtocol, @unchecked Sendable {
    static let okKey = String(repeating: "A", count: 43)
    static let limitedKey = String(repeating: "R", count: 43)
    static let strangerKey = String(repeating: "S", count: 43)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let auth = request.value(forHTTPHeaderField: "Authorization") ?? ""
        let url = request.url!
        var status = 500
        var payload = "{}"
        switch (request.httpMethod, url.path) {
        case ("POST", "/api/v1/shots"):
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "image/jpeg")
            #expect(Self.body(of: request) == Data([0xff, 0xd8, 0xff, 1]))
            let retention = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "retention" }?.value
            if auth == "Bearer \(Self.limitedKey)" {
                status = 429; payload = #"{"error":"rate_limited"}"#
            } else if auth == "Bearer \(Self.okKey)" {
                status = 201
                let expires = retention == "forever" ? "null" : #""2026-12-26T10:00:11.589Z""#
                payload = #"{"id":"lZbAaCNBWpeLnkw4I6f3Lw","url":"https://share.example/lZbAaCNBWpeLnkw4I6f3Lw","imageURL":"https://share.example/i/lZbAaCNBWpeLnkw4I6f3Lw","retention":"\#(retention ?? "")","expiresAt":\#(expires)}"#
            } else {
                status = 401
            }
        case ("DELETE", let path) where path.hasPrefix("/api/v1/shots/"):
            if path.hasSuffix("/goneAAAAAAAAAAAAAAAAAA") { status = 404 }
            else if path.hasSuffix("/hostcheckAAAAAAAAAAAAA") { status = url.host() == "other.example" ? 204 : 403 }
            else if auth == "Bearer \(Self.strangerKey)" { status = 403; payload = #"{"error":"forbidden"}"# }
            else { status = 204; payload = "" }
        default:
            status = 404
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// upload(for:from:) の本文は httpBodyStream で届く
    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

struct CloudShareTests {
    private let jpeg = Data([0xff, 0xd8, 0xff, 1])

    private func client(key: String) -> ShareClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CloudShareStub.self]
        return ShareClient(baseURL: URL(string: "https://share.example")!, deviceKey: key, session: URLSession(configuration: config))
    }

    @Test func uploadReturnsLinkThatExpiresIn30Days() async throws {
        let now = Date(timeIntervalSince1970: 1_795_000_000)
        let share = try await client(key: CloudShareStub.okKey).upload(jpeg, retention: .thirtyDays, now: now)
        #expect(share.id == "lZbAaCNBWpeLnkw4I6f3Lw")
        #expect(share.url.absoluteString == "https://share.example/lZbAaCNBWpeLnkw4I6f3Lw")
        #expect(share.createdAt == now)
        #expect(share.expiresAt == ShareClient.parseDate("2026-12-26T10:00:11.589Z"))
        #expect(share.expiresAt != nil)
    }

    @Test func foreverUploadHasNoExpiry() async throws {
        let share = try await client(key: CloudShareStub.okKey).upload(jpeg, retention: .forever)
        #expect(share.expiresAt == nil)
        #expect(!share.isExpired(now: .distantFuture))
    }

    @Test func rateLimitedUploadExplainsWhatToDo() async throws {
        do {
            _ = try await client(key: CloudShareStub.limitedKey).upload(jpeg, retention: .thirtyDays)
            Issue.record("Rate-limited upload must fail")
        } catch let error as ShareError {
            #expect(error.status == 429)
            #expect(error.code == "rate_limited")
            #expect(error.localizedDescription.contains("1 分"))
        }
    }

    @Test func deletingAnAlreadyGoneLinkSucceeds() async throws {
        try await client(key: CloudShareStub.okKey).delete(id: "goneAAAAAAAAAAAAAAAAAA")
        try await client(key: CloudShareStub.okKey).delete(id: "lZbAaCNBWpeLnkw4I6f3Lw")
    }

    @Test func deleteGoesToTheServerThatCreatedTheLink() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CloudShareStub.self]
        let share = CloudShare(id: "hostcheckAAAAAAAAAAAAA", url: URL(string: "https://other.example/hostcheckAAAAAAAAAAAAA")!, createdAt: Date(), expiresAt: nil)
        let client = try #require(ShareClient.forShare(share, masterKey: try ShareDeviceKey.generate(), session: URLSession(configuration: config)))
        #expect(client.baseURL.absoluteString == "https://other.example")
        try await client.delete(id: share.id)
    }

    @Test func uploadRejectsLinksPointingToAnotherServer() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CloudShareStub.self]
        // スタブは常に share.example のリンクを返す
        let client = ShareClient(baseURL: URL(string: "https://elsewhere.example")!, deviceKey: CloudShareStub.okKey, session: URLSession(configuration: config))
        await #expect(throws: URLError.self) { try await client.upload(jpeg, retention: .thirtyDays) }
    }

    @Test func largeImagesAreShrunkToFitTheUploadLimit() throws {
        // 圧縮しにくいノイズ画像
        let width = 1200, height = 1200
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        var state: UInt32 = 12345
        for i in pixels.indices { state = state &* 1664525 &+ 1013904223; pixels[i] = UInt8(truncatingIfNeeded: state >> 16) }
        let context = try #require(CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                             space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                             bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        let image = try #require(context.makeImage())
        let full = try #require(ImageCodec.jpegData(image))
        let limit = full.count / 3
        let fitted = try #require(ImageCodec.jpegData(image, fitting: limit))
        #expect(fitted.count <= limit)
        #expect(fitted.prefix(2) == Data([0xff, 0xd8]) && fitted.suffix(2) == Data([0xff, 0xd9]))
        #expect(ImageCodec.jpegData(image, fitting: 100) == nil)
    }

    @Test func eachServerGetsItsOwnKey() throws {
        let master = try ShareDeviceKey.generate()
        let official = ShareDeviceKey.key(for: URL(string: "https://share.example")!, master: master)
        let other = ShareDeviceKey.key(for: URL(string: "https://evil.example")!, master: master)
        #expect(official != other)
        #expect(official != master)
        #expect(ShareDeviceKey.isValid(official))
        // 同じサーバーなら同じ鍵（末尾の / の有無にかかわらず）
        #expect(official == ShareDeviceKey.key(for: URL(string: "https://share.example/")!, master: master))
    }

    @Test func refusesToDeleteMalformedIDs() async throws {
        await #expect(throws: URLError.self) { try await client(key: CloudShareStub.okKey).delete(id: "../../api/v1/shots") }
        let tampered = CloudShare(id: "../x", url: URL(string: "https://share.example/x")!, createdAt: Date(), expiresAt: nil)
        #expect(ShareClient.forShare(tampered, masterKey: try ShareDeviceKey.generate()) == nil)
    }

    @Test func dailyQuotaHasItsOwnMessage() {
        #expect(ShareError(status: 429, code: "daily_quota").localizedDescription.contains("明日"))
        #expect(ShareError(status: 503, code: "service_busy").localizedDescription.contains("混み合"))
    }

    @Test func serverURLWithCredentialsIsRejected() {
        #expect(ShareConfig.validated("https://user:pass@share.example") == nil)
    }

    @Test func serverURLsAreNormalizedSoKeysMatch() throws {
        #expect(ShareConfig.validated("HTTPS://Share.Example:443/")?.absoluteString == "https://share.example")
        #expect(ShareConfig.validated("http://[::1]:8787")?.absoluteString == "http://[::1]:8787")
        let master = try ShareDeviceKey.generate()
        #expect(ShareDeviceKey.key(for: URL(string: "https://Share.Example:443")!, master: master)
                == ShareDeviceKey.key(for: URL(string: "https://share.example")!, master: master))
    }

    @Test func anotherMacCannotDelete() async throws {
        do {
            try await client(key: CloudShareStub.strangerKey).delete(id: "lZbAaCNBWpeLnkw4I6f3Lw")
            Issue.record("Delete by another device must fail")
        } catch let error as ShareError {
            #expect(error.status == 403)
        }
    }

    @Test func deviceKeysAreRandomBase64URL() throws {
        let first = try ShareDeviceKey.generate()
        let second = try ShareDeviceKey.generate()
        #expect(first.count == 43)
        #expect(ShareDeviceKey.isValid(first))
        #expect(first != second)
        #expect(!ShareDeviceKey.isValid("short"))
        #expect(!ShareDeviceKey.isValid(String(repeating: "+", count: 43)))
    }

    @Test func serverURLMustBeHTTPSExceptLocalhost() {
        #expect(ShareConfig.validated("https://revvy-share.example.workers.dev/")?.absoluteString == "https://revvy-share.example.workers.dev")
        #expect(ShareConfig.validated("http://127.0.0.1:8787")?.absoluteString == "http://127.0.0.1:8787")
        #expect(ShareConfig.validated("http://example.com") == nil)
        #expect(ShareConfig.validated("revvy.example") == nil)
        #expect(ShareConfig.validated("https://example.com/?x=1") == nil)
        #expect(ShareConfig.resolveBaseURL(override: "  ", bundled: "") == nil)
        #expect(ShareConfig.resolveBaseURL(override: nil, bundled: "https://a.example")?.absoluteString == "https://a.example")
        #expect(ShareConfig.resolveBaseURL(override: "https://b.example", bundled: "https://a.example")?.absoluteString == "https://b.example")
    }

    @Test func oldHistoryWithoutSharesStillLoads() throws {
        let json = #"{"id":"2F6F0D7E-3D4B-4B7A-9C1D-1F2E3D4C5B6A","createdAt":800000000,"note":"","text":""}"#
        let capture = try JSONDecoder().decode(SavedCapture.self, from: Data(json.utf8))
        #expect(capture.shares == nil)
        var updated = capture
        updated.shares = [CloudShare(id: "x", url: URL(string: "https://share.example/x")!, createdAt: Date(), expiresAt: nil)]
        let roundTrip = try JSONDecoder().decode(SavedCapture.self, from: JSONEncoder().encode(updated))
        #expect(roundTrip.shares == updated.shares)
    }

    @Test func expiredSharesAreDetected() {
        let share = CloudShare(id: "x", url: URL(string: "https://share.example/x")!, createdAt: Date(timeIntervalSince1970: 0),
                               expiresAt: Date(timeIntervalSince1970: 100))
        #expect(share.isExpired(now: Date(timeIntervalSince1970: 100)))
        #expect(!share.isExpired(now: Date(timeIntervalSince1970: 99)))
    }

    /// 実際の共有サーバー（手元の wrangler dev か本番）に投げる。TEST_RUNNER_REVVY_SHARE_TEST_URL=<URL> make test で動く。
    /// アプリが実際に作る JPEG（ImageCodec.jpegData）が、サーバーの形式チェックを通ることも確かめる。
    @Test(.enabled(if: ProcessInfo.processInfo.environment["REVVY_SHARE_TEST_URL"] != nil))
    func roundTripAgainstRealServer() async throws {
        let base = try #require(ShareConfig.validated(ProcessInfo.processInfo.environment["REVVY_SHARE_TEST_URL"] ?? ""))
        let owner = ShareClient.make(baseURL: base, masterKey: try ShareDeviceKey.generate())
        let context = try #require(CGContext(data: nil, width: 64, height: 40, bitsPerComponent: 8, bytesPerRow: 0,
                                             space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(srgbRed: 0.2, green: 0.6, blue: 0.4, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 64, height: 40))
        let image = try #require(context.makeImage())
        let rendered = try #require(ImageCodec.jpegData(image))
        let share = try await owner.upload(rendered, retention: .thirtyDays)
        #expect(share.url.host() == base.host())
        let (_, page) = try await URLSession.shared.data(from: share.url)
        #expect((page as? HTTPURLResponse)?.statusCode == 200)
        do {
            try await ShareClient.make(baseURL: base, masterKey: try ShareDeviceKey.generate()).delete(id: share.id)
            Issue.record("Another device must not delete")
        } catch let error as ShareError {
            #expect(error.status == 403)
        }
        try await owner.delete(id: share.id)
        let (_, gone) = try await URLSession.shared.data(from: share.url)
        #expect((gone as? HTTPURLResponse)?.statusCode == 404)
    }
}
