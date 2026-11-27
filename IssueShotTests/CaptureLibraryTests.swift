import AppKit
import Foundation
import Testing
@testable import IssueShot

struct CaptureLibraryTests {
    @Test func persistsNotesOCRAndOriginalAcrossReloadAndDeletes() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let library = CaptureLibrary(directory: directory)
        var capture = SavedCapture(id: UUID(), createdAt: Date(), note: "ログイン画面", text: "")
        let original = Data([1, 2, 3])
        try library.save(capture, png: original)
        let dirMode = (try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)?.intValue
        let imgMode = (try FileManager.default.attributesOfItem(atPath: library.imageURL(capture.id).path)[.posixPermissions] as? NSNumber)?.intValue
        let jsonMode = (try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent(capture.id.uuidString + ".json").path)[.posixPermissions] as? NSNumber)?.intValue
        #expect(dirMode == 0o700)
        #expect(imgMode == 0o600)
        #expect(jsonMode == 0o600)
        capture.text = "Sign in エラー"
        capture.annotations = [Annotation(tool: .arrow, color: .red, points: [.zero, CGPoint(x: 1, y: 1)])]
        try library.update(capture)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: library.imageURL(capture.id).path)
        let reloaded = try CaptureLibrary(directory: directory).load()
        #expect((try FileManager.default.attributesOfItem(atPath: library.imageURL(capture.id).path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        #expect(reloaded == [capture])
        #expect(reloaded[0].matches("ログイン ERROR") == false)
        #expect(reloaded[0].matches("ログイン sign") == true)
        #expect(reloaded[0].matches("エラー") == true)
        #expect(try Data(contentsOf: library.imageURL(capture.id)) == original)
        try library.delete(capture)
        #expect(try library.load().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: library.imageURL(capture.id).path))
    }

    @Test func corruptMetadataIsReportedInsteadOfSilentlyLosingHistory() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("broken".utf8).write(to: directory.appendingPathComponent("broken.json"))
        #expect(throws: (any Error).self) { try CaptureLibrary(directory: directory).load() }
    }

    @Test func missingLibraryStartsEmpty() throws {
        let library = CaptureLibrary(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        #expect(try library.load().isEmpty)
    }

    @Test func keychainRoundTripAndUpdate() throws {
        let store = KeychainStore(service: "com.wanto.IssueShot.tests", account: "test-\(UUID().uuidString)")
        defer { store.delete() }
        #expect(store.read() == nil)
        try store.write("first-secret")
        #expect(store.read() == "first-secret")
        try store.write("updated-secret")
        #expect(store.read() == "updated-secret")
        store.delete()
        #expect(store.read() == nil)
    }

    @MainActor
    @Test func secretPasteboardMarksConcealedAndTransientTypes() {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        SecretPasteboard.copy("top-secret-password", to: board)
        let item = board.pasteboardItems?.first
        #expect(item?.string(forType: .string) == "top-secret-password")
        #expect(item?.types.contains(NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")) == true)
        #expect(item?.types.contains(NSPasteboard.PasteboardType("org.nspasteboard.TransientType")) == true)
    }

    @Test func imageDropValidatesURLsAndSocketDestinations() {
        #expect(ImageDrop.isAllowedRemoteURL(URL(string: "https://cdn.example.com/pic.png")!))
        #expect(!ImageDrop.isAllowedRemoteURL(URL(string: "http://cdn.example.com/pic.png")!))
        #expect(!ImageDrop.isAllowedRemoteURL(URL(string: "https://localhost/pic.png")!))
        #expect(!ImageDrop.isAllowedRemoteURL(URL(string: "https://127.0.0.1/pic.png")!))
        #expect(!ImageDrop.isAllowedRemoteURL(URL(string: "https://10.0.0.5/pic.png")!))
        #expect(!ImageDrop.isAllowedRemoteURL(URL(string: "https://169.254.169.254/latest/meta-data")!))
        #expect(!ImageDrop.isAllowedRemoteURL(URL(string: "https://192.168.1.10/pic.png")!))
        #expect(!ImageDrop.isAllowedRemoteURL(URL(string: "https://[::1]/pic.png")!))
        #expect(!ImageDrop.isAllowedRemoteURL(URL(string: "https://[::ffff:127.0.0.1]/pic.png")!))
        #expect(!ImageDrop.isAllowedRemoteURL(URL(string: "https://user:pass@cdn.example.com/pic.png")!))

        #expect(ImageDrop.allowsConnection(to: "1.1.1.1"))
        #expect(!ImageDrop.allowsConnection(to: "127.0.0.1"))
        #expect(!ImageDrop.allowsConnection(to: "fe80::1"))
        #expect(!ImageDrop.allowsConnection(to: "::ffff:127.0.0.1"))
        #expect(ImageCodec.load(URL(string: "https://example.invalid/image")!) == nil)
    }
}
