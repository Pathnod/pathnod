import Foundation
import PathnodObserverEnrollment
import XCTest

final class ObserverEnrollmentTests: XCTestCase {
    private final class MemoryStore: ObserverSecretStore {
        var secret: Data?
        var loadError: Error?
        var insertError: Error?

        func load() throws -> Data? {
            if let loadError { throw loadError }
            return secret
        }

        func insertIfAbsent(_ value: Data) throws -> Bool {
            if let insertError { throw insertError }
            if secret != nil { return false }
            secret = value
            return true
        }
    }

    private struct Fixture: Decodable {
        struct Vector: Decodable {
            let arity: Int
            let inputs: [String]
            let expectedHex: String
        }
        let vectors: [Vector]
    }

    func testPoseidonMatchesSharedArityOneVectors() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let fixtureURL = root.appendingPathComponent("fixtures/poseidon/bn254-circom-v1.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
        for vector in fixture.vectors where vector.arity == 1 {
            let input = try decimalFieldBytes(vector.inputs[0])
            let actual = try PoseidonCommitment.hashOne(input)
            XCTAssertEqual(actual.map { String(format: "%02x", $0) }.joined(), String(vector.expectedHex.dropFirst(2)))
        }
    }

    func testCredentialPersistsAcrossManagersWithoutRegeneration() throws {
        let store = MemoryStore()
        var randomCalls = 0
        let manager = ObserverCredentialManager(store: store) {
            randomCalls += 1
            return Data(repeating: 0x23, count: 31)
        }
        let first = try manager.loadOrCreate()
        let second = try manager.loadOrCreate()
        XCTAssertEqual(first.secretBytes, second.secretBytes)
        XCTAssertEqual(first.commitmentBytes, second.commitmentBytes)
        XCTAssertEqual(first.commitmentBytes.count, 32)
        XCTAssertEqual(randomCalls, 1)
    }

    func testMalformedExistingSecretIsNeverReplaced() throws {
        let store = MemoryStore()
        store.secret = Data(repeating: 1, count: 30)
        let manager = ObserverCredentialManager(store: store) { XCTFail("Must not generate"); return Data() }
        XCTAssertThrowsError(try manager.loadOrCreate()) { error in
            XCTAssertEqual(error as? ObserverCredentialError, .invalidStoredSecret)
        }
        XCTAssertEqual(store.secret?.count, 30)
    }

    func testStoreFailuresDoNotRotateCredential() throws {
        let store = MemoryStore()
        store.loadError = ObserverCredentialError.keychainFailure(-1)
        let manager = ObserverCredentialManager(store: store) { XCTFail("Must not generate"); return Data() }
        XCTAssertThrowsError(try manager.loadOrCreate())
        XCTAssertNil(store.secret)
    }

    func testFailedInsertCannotProduceACommitment() throws {
        let store = MemoryStore()
        store.insertError = ObserverCredentialError.keychainFailure(-2)
        let manager = ObserverCredentialManager(store: store) { Data(repeating: 7, count: 31) }
        XCTAssertThrowsError(try manager.loadOrCreate())
        XCTAssertNil(store.secret)
    }

    private func decimalFieldBytes(_ value: String) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        for scalar in value.utf8 {
            guard (48...57).contains(scalar) else { throw ObserverCommitmentError.invalidFieldElement }
            var carry = Int(scalar - 48)
            for index in (0..<32).reversed() {
                let next = Int(bytes[index]) * 10 + carry
                bytes[index] = UInt8(next & 0xff)
                carry = next >> 8
            }
            guard carry == 0 else { throw ObserverCommitmentError.invalidFieldElement }
        }
        return Data(bytes)
    }
}
