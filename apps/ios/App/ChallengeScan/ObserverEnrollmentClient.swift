import CryptoKit
import Foundation
import PathnodAppAttest
import PathnodObserverEnrollment

enum ObserverEnrollmentClientError: Error, LocalizedError {
    case invalidURL
    case invalidResponse
    case server(String)
    case initialAttestationRejected(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: "Enter a valid HTTPS URL or a local .local URL for the development server."
        case .invalidResponse: "The enrollment server returned an invalid response."
        case .server(let code): "Enrollment server: \(code)."
        case .initialAttestationRejected(let code): "Enrollment server rejected the initial attestation: \(code)."
        }
    }
}

@MainActor
struct ObserverEnrollmentClient {
    private let baseURL: URL
    private let appAttest = AppAttestClient(
        service: SystemAppAttestService(),
        store: KeychainAppAttestKeyStore(service: "xyz.pathnod.challengescan.appattest")
    )

    init(serverURL: String) throws {
        guard let url = URL(string: serverURL),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil
        else { throw ObserverEnrollmentClientError.invalidURL }
        #if DEBUG
        let localHTTPAllowed = url.scheme == "http" && host.hasSuffix(".local")
        #else
        let localHTTPAllowed = false
        #endif
        guard url.scheme == "https" || localHTTPAllowed else {
            throw ObserverEnrollmentClientError.invalidURL
        }
        baseURL = url
    }

    func enroll(commitment: String) async throws -> ObserverMerklePath {
        let prepared = try await appAttest.prepareKey()
        let issued: EnrollmentChallengeResponse = try await post(
            "/enroll/challenge", body: ["commitment": commitment, "keyID": prepared.keyID]
        )
        let hash = try issued.hash()
        let evidence: Data
        switch issued.mode {
        case "attestation": evidence = try await appAttest.attest(clientDataHash: hash).object
        case "assertion": evidence = try await appAttest.assert(clientDataHash: hash).object
        default: throw ObserverEnrollmentClientError.invalidResponse
        }
        let path: ObserverMerklePath
        do {
            path = try await post("/enroll", body: [
                "challengeID": issued.id, "commitment": commitment,
                "keyID": prepared.keyID, "object": evidence.base64EncodedString()
            ])
        } catch ObserverEnrollmentClientError.server(let code) where
            issued.mode == "attestation" && code.hasPrefix("invalid_attestation") {
            throw ObserverEnrollmentClientError.initialAttestationRejected(code)
        }
        do { try path.validate(expectedCommitment: commitment) }
        catch { throw ObserverEnrollmentClientError.invalidResponse }
        return path
    }

    func refreshPath(commitment: String) async throws -> ObserverMerklePath {
        guard let key = try appAttest.currentKey(), key.attestationReturned
        else { throw AppAttestClientError.missingKey }
        let issued: EnrollmentChallengeResponse = try await post(
            "/tree/challenge", body: ["commitment": commitment, "keyID": key.keyID]
        )
        guard issued.mode == "assertion" else { throw ObserverEnrollmentClientError.invalidResponse }
        let assertion = try await appAttest.assert(clientDataHash: issued.hash())
        var components = URLComponents(url: baseURL.appending(path: "tree"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "commitment", value: commitment)]
        guard let url = components.url else { throw ObserverEnrollmentClientError.invalidURL }
        var request = URLRequest(url: url)
        request.setValue(issued.id, forHTTPHeaderField: "x-pathnod-challenge-id")
        request.setValue(key.keyID, forHTTPHeaderField: "x-pathnod-key-id")
        request.setValue(assertion.object.base64EncodedString(), forHTTPHeaderField: "x-pathnod-assertion")
        let path: ObserverMerklePath = try await send(request)
        do { try path.validate(expectedCommitment: commitment) }
        catch { throw ObserverEnrollmentClientError.invalidResponse }
        return path
    }

    private func post<T: Decodable>(_ path: String, body: [String: String]) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: String(path.dropFirst())))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ObserverEnrollmentClientError.invalidResponse }
        guard response.statusCode == 200 else {
            let error = try? JSONDecoder().decode(ServerError.self, from: data)
            let code = error?.error ?? "HTTP \(response.statusCode)"
            throw ObserverEnrollmentClientError.server(code + (error?.reason.map { " (\($0))" } ?? ""))
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw ObserverEnrollmentClientError.invalidResponse }
    }
}

private struct ServerError: Decodable { let error: String; let reason: String? }

private struct EnrollmentChallengeResponse: Decodable {
    let id: String
    let challenge: String
    let mode: String
    let expiresAt: Int

    func hash() throws -> Data {
        guard expiresAt > Int(Date().timeIntervalSince1970 * 1000),
              let bytes = Data(base64Encoded: challenge), bytes.count == 32
        else { throw ObserverEnrollmentClientError.invalidResponse }
        return Data(SHA256.hash(data: bytes))
    }
}
