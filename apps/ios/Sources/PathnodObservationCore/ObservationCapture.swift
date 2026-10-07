import Foundation
import PathnodChallengeCore

public struct ObservedChallenge: Codable, Sendable {
    public let nonce: Data
    public let response: Data
    public let roundTripMilliseconds: UInt16
    public let rssiDBM: Int8
}

public struct ObservationCapture: Codable, Sendable {
    public let protocolID: Data
    public let deviceID: Data
    public let infoWireData: Data
    public let epoch: UInt32
    public let epochSeconds: UInt32
    public let observationTimeMilliseconds: UInt64
    public let pseudonym: Data
    public let challenges: [ObservedChallenge]
    public let local: ObservationLocalSignals
    public let durationMilliseconds: Double

    public init(info: DeviceProtocolV0.Info, context: ObservationContext, results: [ChallengeResult],
                challengeRSSI: [Int8], local: ObservationLocalSignals, durationMilliseconds: Double) throws {
        guard results.count == 3, challengeRSSI.count == 3,
              results.allSatisfy({ $0.transport == .notification && $0.roundTripMilliseconds.isFinite &&
                  $0.roundTripMilliseconds >= 0 && $0.roundTripMilliseconds <= 65535 &&
                  $0.challenge.observationEpoch == context.epoch && $0.challenge.observationHint == context.observationHint }) else {
            throw ObservationError.invalidCapture
        }
        protocolID = context.protocolID; deviceID = info.deviceID
        var wire = Data([0, 1]) + info.publicKey
        for shift in stride(from: 24, through: 0, by: -8) { wire.append(UInt8(truncatingIfNeeded: info.capabilities >> shift)) }
        infoWireData = wire + info.protocolHint
        epoch = context.epoch; epochSeconds = context.epochSeconds
        observationTimeMilliseconds = context.observationTimeMilliseconds; pseudonym = context.pseudonym
        challenges = zip(results, challengeRSSI).map {
            ObservedChallenge(nonce: $0.0.challenge.nonce, response: $0.0.response.raw,
                              roundTripMilliseconds: UInt16(ceil($0.0.roundTripMilliseconds)), rssiDBM: $0.1)
        }
        self.local = local; self.durationMilliseconds = durationMilliseconds
        try validate()
    }

    public func validate() throws {
        guard protocolID.count == 32, protocolID.contains(where: { $0 != 0 }), pseudonym.count == 32,
              challenges.count == 3, Set(challenges.map(\.nonce)).count == 3,
              durationMilliseconds.isFinite, durationMilliseconds >= 0,
              try ObservationEncoding.epoch(at: observationTimeMilliseconds, seconds: epochSeconds) == epoch else {
            throw ObservationError.invalidCapture
        }
        try local.validate()
        let info = try DeviceProtocolV0.Info(wireData: infoWireData)
        guard info.deviceID == deviceID else { throw ObservationError.invalidCapture }
        var previous: UInt32 = 0
        for entry in challenges {
            guard (-127...0).contains(entry.rssiDBM) else { throw ObservationError.invalidCapture }
            let challenge = try DeviceProtocolV0.Challenge(nonce: entry.nonce, observationEpoch: epoch, observationHint: Data(pseudonym.prefix(8)))
            let response = try DeviceProtocolV0.Response(wireData: entry.response)
            try DeviceProtocolV0.verify(response: response, challenge: challenge, info: info)
            if info.capabilitySet.contains(.monotonicCounter) {
                guard response.deviceCounter > previous else { throw ObservationError.invalidCapture }
            }
            previous = response.deviceCounter
        }
        guard challenges.map(\.roundTripMilliseconds).sorted()[1] <= 400 else { throw ObservationError.invalidCapture }
    }
}
