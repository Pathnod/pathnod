import Foundation
import Security

@MainActor
public struct KeychainAppAttestKeyStore: AppAttestKeyStore {
    private let service: String
    private let account = "app-attest-key-v1"

    public init(service: String) {
        self.service = service
    }

    public func load() throws -> AppAttestKeyRecord? {
        var query = identity
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw AppAttestClientError.keychainFailure(status) }
        guard let data = result as? Data,
              let record = try? JSONDecoder().decode(AppAttestKeyRecord.self, from: data),
              !record.keyID.isEmpty else {
            throw AppAttestClientError.corruptStoredRecord
        }
        return record
    }

    public func save(_ record: AppAttestKeyRecord) throws {
        let data = try JSONEncoder().encode(record)
        var attributes = identity
        attributes[kSecValueData] = data
        attributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update = [kSecValueData: data] as CFDictionary
            let updateStatus = SecItemUpdate(identity as CFDictionary, update)
            guard updateStatus == errSecSuccess else {
                throw AppAttestClientError.keychainFailure(updateStatus)
            }
        } else if status != errSecSuccess {
            throw AppAttestClientError.keychainFailure(status)
        }
    }

    private var identity: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
    }
}
