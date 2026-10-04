import DeviceCheck
import Foundation
import PathnodAppAttest
import XCTest

@MainActor
final class AppAttestClientTests: XCTestCase {
    private final class ServiceDouble: AppAttestService {
        var isSupported = true
        var generated = 0
        var attested: [(String, Data)] = []
        var asserted: [(String, Data)] = []
        var nextAttestationError: Error?
        var attestationObject = Data([0xA1])
        var assertionObject = Data([0xA2])

        func generateKey() async throws -> String {
            generated += 1
            return generated == 1 ? "test-key" : "test-key-\(generated)"
        }

        func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
            attested.append((keyID, clientDataHash))
            if let error = nextAttestationError {
                nextAttestationError = nil
                throw error
            }
            return attestationObject
        }

        func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
            asserted.append((keyID, clientDataHash))
            return assertionObject
        }
    }

    private final class StoreDouble: AppAttestKeyStore {
        var record: AppAttestKeyRecord?

        func load() throws -> AppAttestKeyRecord? { record }
        func save(_ record: AppAttestKeyRecord) throws { self.record = record }
        func clear() throws { record = nil }
    }

    func testRejectsUnsupportedServiceAndWrongHashWidth() async throws {
        let service = ServiceDouble()
        let store = StoreDouble()
        let client = AppAttestClient(service: service, store: store)

        do {
            _ = try await client.attest(clientDataHash: Data(count: 31))
            XCTFail("Expected invalid hash")
        } catch {
            XCTAssertEqual(error as? AppAttestClientError, .invalidClientDataHash)
        }
        XCTAssertEqual(service.generated, 0)

        service.isSupported = false
        do {
            _ = try await client.prepareKey()
            XCTFail("Expected unsupported service")
        } catch {
            XCTAssertEqual(error as? AppAttestClientError, .unsupported)
        }
        XCTAssertEqual(service.generated, 0)
    }

    func testExistingKeychainRecordDecodesWithoutRetryHash() throws {
        let previousRecord = Data(#"{"keyID":"test-key","attestationReturned":true}"#.utf8)
        let decoded = try JSONDecoder().decode(AppAttestKeyRecord.self, from: previousRecord)
        XCTAssertEqual(decoded, AppAttestKeyRecord(keyID: "test-key", attestationReturned: true))
    }

    func testFailedAttestationReusesKeyAndDistinctAssertionsSurviveClientRelaunch() async throws {
        let service = ServiceDouble()
        let store = StoreDouble()
        let firstClient = AppAttestClient(service: service, store: store)
        let attestationHash = Data(repeating: 1, count: 32)
        service.nextAttestationError = DCError(.serverUnavailable)

        do {
            _ = try await firstClient.attest(clientDataHash: attestationHash)
            XCTFail("Expected service failure")
        } catch {
            XCTAssertEqual((error as NSError).domain, DCError.errorDomain)
            XCTAssertEqual((error as NSError).code, DCError.serverUnavailable.rawValue)
            XCTAssertEqual(store.record, AppAttestKeyRecord(
                keyID: "test-key", attestationReturned: false, retryClientDataHash: attestationHash
            ))
        }

        let reopenedClient = AppAttestClient(service: service, store: store)
        do {
            _ = try await reopenedClient.attest(clientDataHash: Data(repeating: 9, count: 32))
            XCTFail("Expected the original hash to be required")
        } catch {
            XCTAssertEqual(error as? AppAttestClientError, .retryRequiresSameClientDataHash)
        }
        XCTAssertEqual(service.attested.count, 1)

        let attestation = try await reopenedClient.attest(clientDataHash: attestationHash)
        XCTAssertTrue(attestation.reusedKey)
        XCTAssertEqual(attestation.object, Data([0xA1]))
        XCTAssertEqual(service.generated, 1)
        XCTAssertEqual(service.attested.count, 2)
        XCTAssertEqual(store.record, AppAttestKeyRecord(keyID: "test-key", attestationReturned: true))

        let firstHash = Data(repeating: 2, count: 32)
        let secondHash = Data(repeating: 3, count: 32)
        let firstAssertion = try await reopenedClient.assert(clientDataHash: firstHash)
        let secondAssertion = try await reopenedClient.assert(clientDataHash: secondHash)
        XCTAssertEqual(firstAssertion.keyID, "test-key")
        XCTAssertEqual(secondAssertion.object, Data([0xA2]))
        XCTAssertEqual(service.asserted.map(\.1), [firstHash, secondHash])
        XCTAssertEqual(service.generated, 1)

        do {
            _ = try await reopenedClient.attest(clientDataHash: attestationHash)
            XCTFail("Expected an already-attested error")
        } catch {
            XCTAssertEqual(error as? AppAttestClientError, .alreadyAttested)
        }
    }

    func testInvalidKeyIsDiscardedBeforeNextAttestation() async throws {
        let service = ServiceDouble()
        let store = StoreDouble()
        let client = AppAttestClient(service: service, store: store)
        let hash = Data(count: 32)
        service.nextAttestationError = DCError(.invalidKey)

        do {
            _ = try await client.attest(clientDataHash: hash)
            XCTFail("Expected invalid key")
        } catch {
            XCTAssertEqual((error as NSError).code, DCError.invalidKey.rawValue)
        }
        XCTAssertNil(store.record)

        let attestation = try await client.attest(clientDataHash: hash)
        XCTAssertEqual(service.generated, 2)
        XCTAssertEqual(service.attested.map(\.0), ["test-key", "test-key-2"])
        XCTAssertEqual(attestation.keyID, "test-key-2")
        XCTAssertFalse(attestation.reusedKey)
    }

    func testAssertionRequiresLocallyReturnedAttestation() async throws {
        let service = ServiceDouble()
        let store = StoreDouble()
        let client = AppAttestClient(service: service, store: store)
        let hash = Data(count: 32)

        do {
            _ = try await client.assert(clientDataHash: hash)
            XCTFail("Expected missing key")
        } catch {
            XCTAssertEqual(error as? AppAttestClientError, .missingKey)
        }

        _ = try await client.prepareKey()
        do {
            _ = try await client.assert(clientDataHash: hash)
            XCTFail("Expected unattested key")
        } catch {
            XCTAssertEqual(error as? AppAttestClientError, .attestationNotReturned)
        }
        XCTAssertTrue(service.asserted.isEmpty)
    }

    func testEmptyServiceObjectsNeverAdvanceState() async throws {
        let service = ServiceDouble()
        let store = StoreDouble()
        let client = AppAttestClient(service: service, store: store)
        let hash = Data(count: 32)
        service.attestationObject = Data()

        do {
            _ = try await client.attest(clientDataHash: hash)
            XCTFail("Expected empty attestation")
        } catch {
            XCTAssertEqual(error as? AppAttestClientError, .emptyObject)
        }
        XCTAssertNil(store.record)

        service.attestationObject = Data([0xA1])
        _ = try await client.attest(clientDataHash: hash)
        service.assertionObject = Data()
        do {
            _ = try await client.assert(clientDataHash: hash)
            XCTFail("Expected empty assertion")
        } catch {
            XCTAssertEqual(error as? AppAttestClientError, .emptyObject)
        }
    }
}
