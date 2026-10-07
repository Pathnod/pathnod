import CryptoKit
import Foundation

public struct ObservationCacheKey: Hashable, Sendable {
    let value: String
    public init(commitment: Data, protocolID: Data, deviceID: Data, epoch: UInt32) throws {
        guard commitment.count == 32, protocolID.count == 32, deviceID.count == 32 else { throw ObservationError.invalidInput }
        var bytes = Data("Pathnod/local-session/v0".utf8) + commitment + protocolID + deviceID
        for shift in stride(from: 24, through: 0, by: -8) { bytes.append(UInt8(truncatingIfNeeded: epoch >> shift)) }
        value = Data(SHA256.hash(data: bytes)).map { String(format: "%02x", $0) }.joined()
    }
}

public protocol ObservationCache {
    func completed(for key: ObservationCacheKey) throws -> ObservationCapture?
    func save(_ capture: ObservationCapture, for key: ObservationCacheKey) throws
}

public final class FileObservationCache: ObservationCache {
    private let url: URL
    public init(url: URL) { self.url = url }

    public func completed(for key: ObservationCacheKey) throws -> ObservationCapture? {
        let entry = try load()[key.value]
        try entry?.validate()
        return entry
    }

    public func save(_ capture: ObservationCapture, for key: ObservationCacheKey) throws {
        try capture.validate()
        var entries = try load(); entries[key.value] = capture
        let now = Date().timeIntervalSince1970 * 1000
        entries = entries.filter { Double(UInt64($0.value.epoch) + 2) * Double($0.value.epochSeconds) * 1000 >= now }
        if entries.count > 256 {
            let oldest = entries.sorted { $0.value.observationTimeMilliseconds < $1.value.observationTimeMilliseconds }
            for entry in oldest.prefix(entries.count - 256) { entries.removeValue(forKey: entry.key) }
        }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(entries)
            #if os(iOS)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            var protectedURL = url; var attributes = URLResourceValues(); attributes.isExcludedFromBackup = true
            try protectedURL.setResourceValues(attributes)
            #else
            try data.write(to: url, options: [.atomic])
            #endif
        } catch { throw ObservationError.cacheUnavailable }
    }

    private func load() throws -> [String: ObservationCapture] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        do {
            let data = try Data(contentsOf: url)
            guard data.count <= 1_048_576 else { throw ObservationError.cacheUnavailable }
            return try JSONDecoder().decode([String: ObservationCapture].self, from: data)
        } catch { throw ObservationError.cacheUnavailable }
    }
}
