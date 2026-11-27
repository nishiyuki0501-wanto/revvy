import AppKit
import Darwin
import UniformTypeIdentifiers

/// ドラッグ＆ドロップで渡された画像を読む。
/// Finder のファイル、ブラウザや写真アプリの画像、macOS のスクリーンショットのサムネイル（ファイルプロミス）、
/// 画像の URL のどれでも受け取れるようにする。
@MainActor
enum ImageDrop {
    static let acceptedTypes: [UTType] = [.fileURL, .image, .url]
    /// リモート URL からの取得上限（25 MB）。巨大ストリームによるメモリ枯渇を防ぐ。
    nonisolated static let maxRemoteBytes = 25 * 1024 * 1024

    /// 最初に画像として読めたものを返す
    static func loadImage(from providers: [NSItemProvider]) async -> CGImage? {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
               let url = await loadURL(provider, type: .fileURL), let image = ImageCodec.load(url) { return image }
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
               let image = await loadFileImage(provider) { return image }
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let url = await loadURL(provider, type: .url),
               let data = await fetchBoundedImageData(from: url), let image = ImageCodec.load(data) { return image }
        }
        return nil
    }

    /// ドロップされた URL が外部 HTTPS かつローカル／プライベート網宛てでないことを確かめる（SSRF・平文 HTTP 防止）
    nonisolated static func isAllowedRemoteURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              components.user == nil, components.password == nil,
              let rawHost = components.host?.lowercased(), !rawHost.isEmpty else { return false }
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") || host.hasSuffix(".internal") {
            return false
        }
        if let v4 = parseIPv4(host) {
            return isPublicIPv4(v4)
        }
        if host.contains(":") {
            return allowsConnection(to: host)
        }
        return true
    }

    nonisolated private static func parseIPv4(_ host: String) -> UInt32? {
        var addr = in_addr()
        guard host.withCString({ inet_pton(AF_INET, $0, &addr) }) == 1 else { return nil }
        return UInt32(bigEndian: addr.s_addr)
    }

    nonisolated private static func isPublicIPv4(_ ip: UInt32) -> Bool {
        let a = (ip >> 24) & 0xff
        let b = (ip >> 16) & 0xff
        if a == 0 || a == 10 || a == 127 || a >= 224 { return false }
        if a == 100 && (64...127).contains(b) { return false } // CGNAT 100.64.0.0/10
        if a == 169 && b == 254 { return false }               // Link-local 169.254.0.0/16
        if a == 172 && (16...31).contains(b) { return false }  // Private 172.16.0.0/12
        if a == 192 && b == 168 { return false }               // Private 192.168.0.0/16
        return true
    }

    nonisolated private static func parseIPv6(_ host: String) -> [UInt8]? {
        var addr = in6_addr()
        guard host.withCString({ inet_pton(AF_INET6, $0, &addr) }) == 1 else { return nil }
        return withUnsafeBytes(of: &addr) { Array($0) }
    }

    nonisolated static func allowsConnection(to address: String) -> Bool {
        if let v4 = parseIPv4(address) { return isPublicIPv4(v4) }
        guard let v6 = parseIPv6(address), (v6[0] & 0xe0) == 0x20 else { return false }
        // Exclude IPv6 transition ranges with embedded IPv4 destinations.
        return !(v6[0] == 0x20 && (v6[1] == 2 || (v6[1] == 1 && v6[2] == 0 && v6[3] == 0)))
    }

    nonisolated static func fetchBoundedImageData(from url: URL) async -> Data? {
        await Task.detached(priority: .utility) {
            var current = url
            for _ in 0...3 {
                guard isAllowedRemoteURL(current) else { return nil }
                var redirect: NSURL?
                guard let data = RevvyFetchImage(current, UInt(maxRemoteBytes), { allowsConnection(to: $0) }, &redirect) else { return nil }
                guard let redirect else { return data }
                current = redirect as URL
            }
            return nil
        }.value
    }

    private static func loadData(_ provider: NSItemProvider, type: UTType) async -> Data? {
        await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }

    /// ファイルプロミスは一時ファイルとして渡され、コールバックを抜けると消えるので中で読み切る。
    private static func loadFileImage(_ provider: NSItemProvider) async -> CGImage? {
        await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
                continuation.resume(returning: url.flatMap(ImageCodec.load))
            }
        }
    }

    private static func loadURL(_ provider: NSItemProvider, type: UTType) async -> URL? {
        guard let data = await loadData(provider, type: type) else { return nil }
        return URL(dataRepresentation: data, relativeTo: nil)
    }
}
