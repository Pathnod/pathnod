import Foundation

public struct ObservationChainStatus: Codable, Sendable {
    public let network: String
    public let program: String
    public let protocolID: String
    public let deviceID: String
    public let epoch: UInt32
    public let transcriptHash: String
    public let status: String
    public let onChain: Bool
    public let paid: Bool?
    public let independentObservers: UInt16?
    public let paidSlotsUsed: UInt8?
    public let observationRoot: String?
    public let transactionSignature: String?
    public let duplicate: ObservationDuplicateStatus?

    enum CodingKeys: String, CodingKey {
        case network, program, epoch, status, paid, duplicate
        case protocolID = "protocol_id", deviceID = "device_id", transcriptHash = "transcript_hash"
        case onChain = "on_chain", independentObservers = "independent_observers"
        case paidSlotsUsed = "paid_slots_used", observationRoot = "observation_root"
        case transactionSignature = "transaction_signature"
    }

    public func validate(hash: String, protocolID expectedProtocol: String, deviceID expectedDevice: String) throws {
        guard transcriptHash == hash, protocolID == expectedProtocol, deviceID == expectedDevice,
              [hash, protocolID, deviceID].allSatisfy(Self.hex32),
              ["devnet", "local-validator"].contains(network) else { throw ObservationError.invalidInput }
        _ = try SolanaBase58.decode32(program)
        if onChain {
            guard status == "finalized", paid != nil,
                  let count = independentObservers, count > 0,
                  let used = paidSlotsUsed, used <= count,
                  paid != true || used > 0,
                  let root = observationRoot, Self.hex32(root) else { throw ObservationError.invalidInput }
        } else {
            guard ["queued", "submitted", "failed"].contains(status), paid == nil,
                  independentObservers == nil, paidSlotsUsed == nil, observationRoot == nil,
                  transactionSignature == nil else { throw ObservationError.invalidInput }
        }
        if let signature = transactionSignature {
            guard !signature.isEmpty, signature.count <= 88,
                  signature.utf8.allSatisfy({ "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8.contains($0) })
            else { throw ObservationError.invalidInput }
        }
        if let duplicate {
            guard onChain, duplicate.status == "rejected", duplicate.error == "E_NULLIFIER", duplicate.unchanged,
                  !duplicate.transactionSignature.isEmpty, duplicate.transactionSignature.count <= 88,
                  duplicate.transactionSignature.utf8.allSatisfy({ "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8.contains($0) })
            else { throw ObservationError.invalidInput }
        }
    }

    private static func hex32(_ value: String) -> Bool {
        value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

public struct ObservationDuplicateStatus: Codable, Sendable {
    public let status: String
    public let error: String
    public let unchanged: Bool
    public let transactionSignature: String
    enum CodingKeys: String, CodingKey {
        case status, error, unchanged
        case transactionSignature = "transaction_signature"
    }
}

public struct ObservationStatusClient: Sendable {
    private let endpoint: URL
    @MainActor public init(baseURL: URL, allowLocalHTTP: Bool = false) throws {
        endpoint = try ObservationHTTPClient(baseURL: baseURL, allowLocalHTTP: allowLocalHTTP).endpoint
    }
    public func read(hash: String, protocolID: String, deviceID: String) async throws -> ObservationChainStatus {
        guard hash.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw ObservationError.invalidInput }
        var request = URLRequest(url: endpoint.appending(path: hash + "/status")); request.timeoutInterval = 15
        let session = URLSession(configuration: .ephemeral, delegate: StatusRedirectPolicy(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 8192 else { throw ObservationError.invalidInput }
        let status = try JSONDecoder().decode(ObservationChainStatus.self, from: data)
        try status.validate(hash: hash, protocolID: protocolID, deviceID: deviceID)
        return status
    }
}

private final class StatusRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
