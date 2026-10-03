import CryptoKit
import Foundation

struct DeviceEvidenceCapture: Decodable {
    let session: String
    let attestationChallenge: String
    let firstAssertionChallenge: String
    let secondAssertionChallenge: String

    static var isRequested: Bool {
        ProcessInfo.processInfo.environment["PATHNOD_DEV19_CAPTURE"] == "1"
    }

    static func load() throws -> Self {
        let data = try Data(contentsOf: documentsURL.appendingPathComponent("dev19-challenges.json"))
        let request = try JSONDecoder().decode(Self.self, from: data)
        guard UUID(uuidString: request.session) != nil else { throw CaptureError.invalidRequest }
        _ = try request.hash(request.attestationChallenge)
        _ = try request.hash(request.firstAssertionChallenge)
        _ = try request.hash(request.secondAssertionChallenge)
        return request
    }

    var keychainService: String { "xyz.pathnod.appattestspike.dev19.\(session)" }

    func hash(_ base64Challenge: String) throws -> Data {
        guard let bytes = Data(base64Encoded: base64Challenge), bytes.count == 32 else {
            throw CaptureError.invalidRequest
        }
        return Data(SHA256.hash(data: bytes))
    }

    func save(keyID: String, attestation: Data, firstAssertion: Data, secondAssertion: Data) throws {
        let evidence = Evidence(
            session: session,
            keyID: keyID,
            attestationChallenge: attestationChallenge,
            firstAssertionChallenge: firstAssertionChallenge,
            secondAssertionChallenge: secondAssertionChallenge,
            attestation: attestation.base64EncodedString(),
            firstAssertion: firstAssertion.base64EncodedString(),
            secondAssertion: secondAssertion.base64EncodedString()
        )
        let data = try JSONEncoder().encode(evidence)
        try data.write(
            to: Self.documentsURL.appendingPathComponent("dev19-evidence.json"),
            options: [.atomic, .completeFileProtection]
        )
    }

    private static var documentsURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private struct Evidence: Encodable {
        let session: String
        let keyID: String
        let attestationChallenge: String
        let firstAssertionChallenge: String
        let secondAssertionChallenge: String
        let attestation: String
        let firstAssertion: String
        let secondAssertion: String
    }

    private enum CaptureError: Error {
        case invalidRequest
    }
}
