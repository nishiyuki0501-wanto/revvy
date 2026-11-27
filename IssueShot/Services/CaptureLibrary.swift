import AppKit
import Foundation
import Vision

struct SavedCapture: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let createdAt: Date
    var note: String
    var text: String
    var annotations: [Annotation]? = nil
    /// このキャプチャから作った共有リンク。古い履歴には無いので省略可能にする。
    var shares: [CloudShare]? = nil

    func matches(_ query: String) -> Bool {
        let words = query.split(whereSeparator: \.isWhitespace)
        let content = note + "\n" + text + "\n" + createdAt.formatted(date: .numeric, time: .shortened)
        return words.allSatisfy { content.localizedStandardContains(String($0)) }
    }
}

/// A sidecar per image makes a failed metadata write recoverable without overwriting the library.
struct CaptureLibrary {
    let directory: URL

    init(directory: URL = URL.applicationSupportDirectory.appending(path: "Revvy/Captures", directoryHint: .isDirectory)) {
        self.directory = directory
    }

    func imageURL(_ id: UUID) -> URL { directory.appendingPathComponent(id.uuidString + ".png") }
    private func metadataURL(_ id: UUID) -> URL { directory.appendingPathComponent(id.uuidString + ".json") }

    func load() throws -> [SavedCapture] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        try ensureRestrictedDirectory()
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            .filter { ["png", "json"].contains($0.pathExtension) }
        for file in files {
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { throw CocoaError(.fileReadUnknown) }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        return try files
            .filter { $0.pathExtension == "json" }
            .map { try JSONDecoder().decode(SavedCapture.self, from: Data(contentsOf: $0)) }
            .filter { FileManager.default.fileExists(atPath: imageURL($0.id).path) }
            .sorted { $0.createdAt > $1.createdAt }
    }

    func save(_ capture: SavedCapture, png: Data) throws {
        try ensureRestrictedDirectory()
        let imgURL = imageURL(capture.id)
        try writeRestricted(png, to: imgURL)
        do { try update(capture) }
        catch { try? FileManager.default.removeItem(at: imgURL); throw error }
    }

    func update(_ capture: SavedCapture) throws {
        try ensureRestrictedDirectory()
        try writeRestricted(JSONEncoder().encode(capture), to: metadataURL(capture.id))
    }

    /// 非サンドボックス版でも他ユーザーや不要な権限から保護するため、ディレクトリは 0700・ファイルは 0600 に制限する
    private func ensureRestrictedDirectory() throws {
        let fm = FileManager.default
        let parent = directory.deletingLastPathComponent()
        if parent.lastPathComponent == "Revvy" {
            try fm.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent.path)
        }
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }

    private func writeRestricted(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    func delete(_ capture: SavedCapture) throws {
        // Metadata first: failed image cleanup never leaves an unusable history entry.
        try FileManager.default.removeItem(at: metadataURL(capture.id))
        try FileManager.default.removeItem(at: imageURL(capture.id))
    }
}

enum CaptureTextRecognition {
    static func recognize(png: Data) async throws -> String {
        try await Task.detached(priority: .utility) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["ja-JP", "en-US"]
            request.usesLanguageCorrection = true
            try VNImageRequestHandler(data: png).perform([request])
            return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        }.value
    }
}
