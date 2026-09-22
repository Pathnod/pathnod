import Foundation
import SwiftUI
import UniformTypeIdentifiers

/// The export as a document the system file exporter can write.
///
/// It carries the already-encoded bytes rather than the session, so what the
/// user saves is exactly what ``DensityExport`` validated and encoded.
struct DensityExportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }

    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        guard let contents = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        data = contents
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

/// The only place an export is ever written to disk.
///
/// Exports live in the app's caches directory, never in Documents, never in a
/// backup-visible location, and never beyond the session that produced them:
/// the directory is cleared on launch, on Delete, and whenever a new session
/// starts. A cached file holds aggregate counters only, so losing one to a cache
/// eviction costs nothing.
struct DensityExportStore {
    /// Subdirectory so that clearing it cannot remove anything else the system
    /// put in the caches directory.
    private static let directoryName = "DensityExports"

    private let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    private var directory: URL? {
        fileManager
            .urls(for: .cachesDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent(Self.directoryName, isDirectory: true)
    }

    /// Replaces any previous export with this one and returns its location.
    ///
    /// A session exports one file; writing a second one for the same session
    /// must not leave the first behind for the share sheet to pick up.
    func write(_ data: Data, named fileName: String) throws -> URL {
        guard let directory else {
            throw CocoaError(.fileNoSuchFile)
        }

        try clear()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)

        let url = directory.appendingPathComponent(fileName, isDirectory: false)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    /// Removes every cached export. Safe to call when nothing was ever written.
    func clear() throws {
        guard let directory, fileManager.fileExists(atPath: directory.path) else { return }
        try fileManager.removeItem(at: directory)
    }
}
