import Foundation
import Security

public enum ObserverCredentialError: Error, Equatable {
    case keychainFailure(OSStatus)
    case invalidStoredSecret
    case randomFailure(OSStatus)
    case concurrentCreationFailed
}

public struct ObserverCredential {
    public let secretBytes: Data
    public let commitmentBytes: Data

    public var commitmentHex: String {
        commitmentBytes.map { String(format: "%02x", $0) }.joined()
    }
}

public protocol ObserverSecretStore {
    func load() throws -> Data?
    func insertIfAbsent(_ secret: Data) throws -> Bool
}

public struct KeychainObserverSecretStore: ObserverSecretStore {
    private let service: String
    private let account = "observer-secret-v1"

    public init(service: String = "xyz.pathnod.observer-enrollment") {
        self.service = service
    }

    public func load() throws -> Data? {
        var query = identity
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw ObserverCredentialError.keychainFailure(status) }
        guard let data = result as? Data else { throw ObserverCredentialError.invalidStoredSecret }
        return data
    }

    public func insertIfAbsent(_ secret: Data) throws -> Bool {
        guard secret.count == 31 else { throw ObserverCredentialError.invalidStoredSecret }
        var attributes = identity
        attributes[kSecValueData] = secret
        attributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem { return false }
        guard status == errSecSuccess else { throw ObserverCredentialError.keychainFailure(status) }
        return true
    }

    private var identity: [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
    }
}

public struct ObserverCredentialManager {
    private let store: any ObserverSecretStore
    private let randomBytes: () throws -> Data

    public init(
        store: any ObserverSecretStore = KeychainObserverSecretStore(),
        randomBytes: @escaping () throws -> Data = ObserverCredentialManager.secureRandomBytes
    ) {
        self.store = store
        self.randomBytes = randomBytes
    }

    public func loadOrCreate() throws -> ObserverCredential {
        if let existing = try store.load() { return try credential(for: existing) }
        let fresh = try randomBytes()
        guard fresh.count == 31 else { throw ObserverCredentialError.invalidStoredSecret }
        if try store.insertIfAbsent(fresh) { return try credential(for: fresh) }
        guard let existing = try store.load() else { throw ObserverCredentialError.concurrentCreationFailed }
        return try credential(for: existing)
    }

    private func credential(for secret: Data) throws -> ObserverCredential {
        guard secret.count == 31 else { throw ObserverCredentialError.invalidStoredSecret }
        let fieldBytes = Data([0]) + secret
        let commitment = try PoseidonCommitment.hashOne(fieldBytes)
        return ObserverCredential(secretBytes: secret, commitmentBytes: commitment)
    }

    public static func secureRandomBytes() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 31)
        let status = bytes.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!)
        }
        guard status == errSecSuccess else { throw ObserverCredentialError.randomFailure(status) }
        return Data(bytes)
    }
}
