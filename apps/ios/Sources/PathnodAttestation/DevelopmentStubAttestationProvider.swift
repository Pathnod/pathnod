import CryptoKit
import Foundation

public final class DevelopmentStubAttestationProvider: AttestationProvider, @unchecked Sendable {
    public static let schemaVersion = 1
    public static let providerIdentifier = "development_stub"
    public static let environment = "development"
    public static let assurance = "none"
    public static let clientDataHashByteCount = 32
    public static let domainSeparator = "Pathnod/development-stub-attestation/v1"

    private let logger: any AttestationWarningLogging

    public init(logger: any AttestationWarningLogging = ConsoleAttestationWarningLogger()) throws {
        self.logger = logger
        #if !DEBUG
        throw AttestationProviderError.stubForbiddenInRelease
        #endif
    }

    public func attest(purpose: AttestationPurpose, clientDataHash: Data) throws -> AttestationEnvelope {
        guard clientDataHash.count == Self.clientDataHashByteCount else {
            throw AttestationProviderError.invalidClientDataHash
        }

        var input = Data(Self.domainSeparator.utf8)
        input.append(0)
        input.append(contentsOf: purpose.rawValue.utf8)
        input.append(0)
        input.append(clientDataHash)

        let proof = Data(SHA256.hash(data: input)).base64URLEncodedString()
        logger.warning(Self.warningEvent(for: purpose))

        return AttestationEnvelope(
            schemaVersion: Self.schemaVersion,
            provider: Self.providerIdentifier,
            environment: Self.environment,
            purpose: purpose,
            proof: proof
        )
    }

    private static func warningEvent(for purpose: AttestationPurpose) -> AttestationWarningEvent {
        AttestationWarningEvent(
            event: "development_stub_attestation_generated",
            message: "DEVELOPMENT ONLY: generated a development-stub attestation. It provides no hardware assurance.",
            provider: providerIdentifier,
            environment: environment,
            assurance: assurance,
            purpose: purpose
        )
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
