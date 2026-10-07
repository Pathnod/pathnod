import Foundation

public struct ObservationEligibility: Codable, Sendable, Equatable {
    public let registered: Bool
    public let protocolID: String
    public let openSlots: UInt8
    public let reward: String
    public let policyVersion: UInt32
    enum CodingKeys: String, CodingKey {
        case registered, reward
        case protocolID = "protocol_id", openSlots = "open_slots", policyVersion = "policy_version"
    }

    public func validate() throws {
        let bytes = try ObservationEncoding.id(protocolID)
        guard bytes.contains(where: { $0 != 0 }), policyVersion > 0,
              reward.range(of: "^(0|[1-9][0-9]*)(\\.[0-9]{1,6})?$", options: .regularExpression) != nil,
              registered || (openSlots == 0 && reward == "0") else { throw ObservationError.invalidEligibility }
    }
}

public struct ResolvedEligibility: Sendable {
    public let quote: ObservationEligibility
    public let epochSeconds: UInt32
    public let epoch: UInt32
    public let observationTimeMilliseconds: UInt64
    public func requireCollectionPermission(allowUnpaid: Bool) throws {
        guard quote.registered else { throw ObservationError.unknownDevice }
        guard quote.openSlots > 0 || allowUnpaid else { throw ObservationError.unpaidNotAllowed }
    }
}

public struct EligibilityClient: Sendable {
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    private let baseURL: URL
    private let transport: Transport

    public init(baseURL: URL, transport: @escaping Transport = { request in
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ObservationError.invalidEligibility }
        return (data, response)
    }) throws {
        guard baseURL.host != nil, baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil, ["http", "https"].contains(baseURL.scheme) else {
            throw ObservationError.invalidInput
        }
        self.baseURL = baseURL; self.transport = transport
    }

    public func resolve(deviceID: Data, timeMilliseconds: UInt64, protocolID: Data? = nil) async throws -> ResolvedEligibility {
        guard deviceID.count == 32, protocolID == nil || protocolID?.count == 32 else { throw ObservationError.invalidInput }
        var epoch = try ObservationEncoding.epoch(at: timeMilliseconds, seconds: 604800)
        var firstProtocol: String?
        for attempt in 0..<2 {
            try Task.checkCancellation()
            var components = URLComponents(url: baseURL.appending(path: "devices/\(ObservationEncoding.hex(deviceID))/slots"), resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "epoch", value: String(epoch))]
            if let protocolID { components.queryItems?.append(URLQueryItem(name: "protocol_id", value: ObservationEncoding.hex(protocolID))) }
            guard let url = components.url else { throw ObservationError.invalidInput }
            var request = URLRequest(url: url); request.timeoutInterval = 10
            let (data, response) = try await transport(request)
            try Task.checkCancellation()
            guard response.statusCode == 200 else {
                throw ObservationError.server("HTTP \(response.statusCode)")
            }
            guard data.count <= 4096,
                  let duration = response.value(forHTTPHeaderField: "x-pathnod-epoch-seconds"),
                  let seconds = UInt32(duration), seconds > 0,
                  let quote = try? JSONDecoder().decode(ObservationEligibility.self, from: data) else {
                throw ObservationError.invalidEligibility
            }
            try quote.validate()
            if let protocolID, try ObservationEncoding.id(quote.protocolID) != protocolID { throw ObservationError.invalidEligibility }
            if let firstProtocol, firstProtocol != quote.protocolID { throw ObservationError.invalidEligibility }
            firstProtocol = quote.protocolID
            let correctEpoch = try ObservationEncoding.epoch(at: timeMilliseconds, seconds: seconds)
            if correctEpoch == epoch {
                return ResolvedEligibility(quote: quote, epochSeconds: seconds, epoch: epoch, observationTimeMilliseconds: timeMilliseconds)
            }
            guard attempt == 0 else { throw ObservationError.invalidEligibility }
            epoch = correctEpoch
        }
        throw ObservationError.invalidEligibility
    }

    public func prepareConnection() async throws {
        var request = URLRequest(url: baseURL.appending(path: "health")); request.timeoutInterval = 10
        try Task.checkCancellation()
        let (_, response) = try await transport(request)
        try Task.checkCancellation()
        guard (200..<300).contains(response.statusCode) else { throw ObservationError.server("HTTP \(response.statusCode)") }
    }
}
