import DeviceCheck
import Foundation

public struct AppAttestKeyRecord: Codable, Equatable, Sendable {
    public let keyID: String
    public let attestationReturned: Bool

    public init(keyID: String, attestationReturned: Bool) {
        self.keyID = keyID
        self.attestationReturned = attestationReturned
    }
}

public enum AppAttestClientError: Error, Equatable {
    case unsupported
    case invalidClientDataHash
    case emptyKeyIdentifier
    case emptyObject
    case missingKey
    case attestationNotReturned
    case alreadyAttested
    case corruptStoredRecord
    case keychainFailure(Int32)
}

@MainActor
public protocol AppAttestService {
    var isSupported: Bool { get }
    func generateKey() async throws -> String
    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data
    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data
}

@MainActor
public struct SystemAppAttestService: AppAttestService {
    public init() {}

    public var isSupported: Bool { DCAppAttestService.shared.isSupported }

    public func generateKey() async throws -> String {
        try await DCAppAttestService.shared.generateKey()
    }

    public func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        try await DCAppAttestService.shared.attestKey(keyID, clientDataHash: clientDataHash)
    }

    public func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
        try await DCAppAttestService.shared.generateAssertion(keyID, clientDataHash: clientDataHash)
    }
}

@MainActor
public protocol AppAttestKeyStore {
    func load() throws -> AppAttestKeyRecord?
    func save(_ record: AppAttestKeyRecord) throws
}

public struct AppAttestAttestation {
    public let keyID: String
    public let object: Data
    public let reusedKey: Bool
}

public struct AppAttestAssertion {
    public let keyID: String
    public let object: Data
}

@MainActor
public final class AppAttestClient {
    private let service: any AppAttestService
    private let store: any AppAttestKeyStore

    public init(service: any AppAttestService, store: any AppAttestKeyStore) {
        self.service = service
        self.store = store
    }

    public var isSupported: Bool { service.isSupported }

    public func currentKey() throws -> AppAttestKeyRecord? {
        try store.load()
    }

    public func prepareKey() async throws -> (keyID: String, reused: Bool) {
        guard service.isSupported else { throw AppAttestClientError.unsupported }
        if let record = try store.load() {
            guard !record.keyID.isEmpty else { throw AppAttestClientError.corruptStoredRecord }
            return (record.keyID, true)
        }

        let keyID = try await service.generateKey()
        guard !keyID.isEmpty else { throw AppAttestClientError.emptyKeyIdentifier }
        try store.save(AppAttestKeyRecord(keyID: keyID, attestationReturned: false))
        return (keyID, false)
    }

    public func attest(clientDataHash: Data) async throws -> AppAttestAttestation {
        guard clientDataHash.count == 32 else { throw AppAttestClientError.invalidClientDataHash }
        let key = try await prepareKey()
        if try store.load()?.attestationReturned == true {
            throw AppAttestClientError.alreadyAttested
        }

        let object = try await service.attestKey(key.keyID, clientDataHash: clientDataHash)
        guard !object.isEmpty else { throw AppAttestClientError.emptyObject }
        try store.save(AppAttestKeyRecord(keyID: key.keyID, attestationReturned: true))
        return AppAttestAttestation(keyID: key.keyID, object: object, reusedKey: key.reused)
    }

    public func assert(clientDataHash: Data) async throws -> AppAttestAssertion {
        guard clientDataHash.count == 32 else { throw AppAttestClientError.invalidClientDataHash }
        guard service.isSupported else { throw AppAttestClientError.unsupported }
        guard let record = try store.load() else { throw AppAttestClientError.missingKey }
        guard record.attestationReturned else { throw AppAttestClientError.attestationNotReturned }

        let object = try await service.generateAssertion(record.keyID, clientDataHash: clientDataHash)
        guard !object.isEmpty else { throw AppAttestClientError.emptyObject }
        return AppAttestAssertion(keyID: record.keyID, object: object)
    }
}
