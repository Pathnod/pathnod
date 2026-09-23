import Foundation

public protocol AttestationProvider: Sendable {
    func attest(purpose: AttestationPurpose, clientDataHash: Data) throws -> AttestationEnvelope
}
