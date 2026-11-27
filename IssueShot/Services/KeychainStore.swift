import AppKit
import Foundation
import Security

/// GitHub トークンと共有用の端末キーを Keychain に保存する（UserDefaults に平文で置かない）
struct KeychainStore: Sendable {
    let service: String
    let account: String

    static let gitHubToken = KeychainStore(service: "com.wanto.IssueShot", account: "github-token")
    /// 共有リンク用の端末キー（ShareDeviceKey）
    static let shareDeviceKey = KeychainStore(service: "com.wanto.IssueShot", account: "share-device-key")
    /// 共有リンクに付けるパスワード
    static let sharePassword = KeychainStore(service: "com.wanto.IssueShot", account: "share-password")

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrSynchronizable as String: false,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func read() -> String? { try? readIfPresent() }

    func readIfPresent() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            throw KeychainError(status: errSecDecode)
        }
        return value
    }

    func write(_ value: String) throws {
        let data = Data(value.utf8)
        // この Mac のみに限定し、iCloud Keychain 等での他端末同期を防ぐ
        let updateAttrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        var status = SecItemUpdate(baseQuery as CFDictionary, updateAttrs as CFDictionary)
        if status == errSecParam {
            // 旧ファイルベース Keychain で Accessible 更新を受け付けない場合のフォールバック
            status = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        }
        if status == errSecItemNotFound {
            var query = baseQuery
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}

/// パスワードや編集用合言葉など、クリップボード履歴ツールや Universal Clipboard に残したくない文字列を書き込む
enum SecretPasteboard {
    private static let concealedType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
    private static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    @MainActor
    static func copy(_ value: String, concealed: Bool = true, to pasteboard: NSPasteboard = .general) {
        if concealed {
            _ = pasteboard.prepareForNewContents(with: .currentHostOnly)
            let item = NSPasteboardItem()
            item.setString(value, forType: .string)
            item.setData(Data(), forType: concealedType)
            item.setData(Data(), forType: transientType)
            pasteboard.writeObjects([item])
        } else {
            pasteboard.clearContents()
            pasteboard.setString(value, forType: .string)
        }
    }
}

struct KeychainError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? {
        let detail = SecCopyErrorMessageString(status, nil) as String? ?? String(localized: "不明")
        return String(localized: "Keychain エラー (\(status)): \(detail)")
    }
}
