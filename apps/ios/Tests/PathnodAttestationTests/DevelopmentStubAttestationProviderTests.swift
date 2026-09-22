import Foundation
import Testing
@testable import PathnodAttestation

private struct Fixture: Decodable {
    let schemaVersion: Int
    let provider: String
    let environment: String
    let assurance: String
    let domainSeparator: String
    let clientDataHashByteLength: Int
    let proofByteLength: Int
    let vectors: [Vector]

    struct Vector: Decodable {
        let name: String
        let purpose: AttestationPurpose
        let clientDataHash: String
        let envelope: AttestationEnvelope
    }
}

private final class RecordingLogger: AttestationWarningLogging, @unchecked Sendable {
    private(set) var events: [AttestationWarningEvent] = []

    func warning(_ event: AttestationWarningEvent) {
        events.append(event)
    }
}

@Suite("Development-only attestation provider")
struct DevelopmentStubAttestationProviderTests {
    @Test("produces every canonical fixture vector")
    func canonicalFixtureVectors() throws {
        let fixture = try loadFixture()

        #expect(fixture.schemaVersion == DevelopmentStubAttestationProvider.schemaVersion)
        #expect(fixture.provider == DevelopmentStubAttestationProvider.providerIdentifier)
        #expect(fixture.environment == DevelopmentStubAttestationProvider.environment)
        #expect(fixture.assurance == DevelopmentStubAttestationProvider.assurance)
        #expect(fixture.domainSeparator == DevelopmentStubAttestationProvider.domainSeparator)
        #expect(fixture.clientDataHashByteLength == DevelopmentStubAttestationProvider.clientDataHashByteCount)
        #expect(fixture.proofByteLength == 32)
        #expect(fixture.vectors.count >= 2)

        for vector in fixture.vectors {
            let logger = RecordingLogger()
            let provider = try DevelopmentStubAttestationProvider(logger: logger)
            let clientDataHash = try decodeBase64URLStrict(
                vector.clientDataHash,
                expectedByteCount: fixture.clientDataHashByteLength
            )

            let envelope = try provider.attest(purpose: vector.purpose, clientDataHash: clientDataHash)

            #expect(envelope == vector.envelope, Comment(rawValue: vector.name))
            #expect(logger.events.count == 1)
            let event = try #require(logger.events.first)
            #expect(event.event == "development_stub_attestation_generated")
            #expect(event.provider == "development_stub")
            #expect(event.environment == "development")
            #expect(event.assurance == "none")
            #expect(event.purpose == vector.purpose)
            #expect(event.message.contains("DEVELOPMENT ONLY"))
            #expect(event.message.contains("no hardware assurance"))
            #expect(!event.message.contains(vector.clientDataHash))
            #expect(!event.message.contains(vector.envelope.proof))
        }
    }

    @Test("proof output is deterministic")
    func deterministicOutput() throws {
        let provider = try DevelopmentStubAttestationProvider(logger: RecordingLogger())
        let clientDataHash = Data(repeating: 0xA5, count: 32)

        let first = try provider.attest(purpose: .observation, clientDataHash: clientDataHash)
        let second = try provider.attest(purpose: .observation, clientDataHash: clientDataHash)

        #expect(first == second)
        #expect(!first.proof.contains("="))
    }

    @Test("rejects client-data hashes that are not exactly 32 bytes", arguments: [0, 31, 33])
    func invalidClientDataHashLength(byteCount: Int) throws {
        let provider = try DevelopmentStubAttestationProvider(logger: RecordingLogger())

        #expect(throws: AttestationProviderError.invalidClientDataHash) {
            try provider.attest(purpose: .enrollment, clientDataHash: Data(repeating: 0, count: byteCount))
        }
    }

    @Test("factory requires the exact development stub opt-in")
    func explicitConfiguration() throws {
        #expect(throws: AttestationProviderError.stubDisabled) {
            try AttestationProviderFactory.make(configuredProvider: nil)
        }
        #expect(throws: AttestationProviderError.stubDisabled) {
            try AttestationProviderFactory.make(configuredProvider: "")
        }
        #expect(throws: AttestationProviderError.unsupportedProvider) {
            try AttestationProviderFactory.make(configuredProvider: "app_attest")
        }
        #expect(throws: AttestationProviderError.unsupportedProvider) {
            try AttestationProviderFactory.make(configuredProvider: "DEVELOPMENT_STUB")
        }

        let provider = try AttestationProviderFactory.make(
            configuredProvider: "development_stub",
            buildConfiguration: .debug,
            logger: RecordingLogger()
        )
        #expect(provider is DevelopmentStubAttestationProvider)
    }

    @Test("factory fails closed for release builds")
    func releaseConfigurationIsForbidden() {
        #expect(throws: AttestationProviderError.stubForbiddenInRelease) {
            try AttestationProviderFactory.make(
                configuredProvider: "development_stub",
                buildConfiguration: .release,
                logger: RecordingLogger()
            )
        }
    }
}

private func loadFixture() throws -> Fixture {
    var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    for _ in 0..<4 {
        directory.deleteLastPathComponent()
    }
    let fixtureURL = directory
        .appendingPathComponent("fixtures")
        .appendingPathComponent("attestation")
        .appendingPathComponent("development-stub-v1.json")
    return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
}

private func decodeBase64URLStrict(_ value: String, expectedByteCount: Int) throws -> Data {
    guard !value.isEmpty,
          !value.contains("="),
          value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    else {
        throw CocoaError(.fileReadCorruptFile)
    }

    let standard = value
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    let padding = String(repeating: "=", count: (4 - standard.count % 4) % 4)
    guard let decoded = Data(base64Encoded: standard + padding),
          decoded.count == expectedByteCount,
          encodeBase64URL(decoded) == value
    else {
        throw CocoaError(.fileReadCorruptFile)
    }
    return decoded
}

private func encodeBase64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}
