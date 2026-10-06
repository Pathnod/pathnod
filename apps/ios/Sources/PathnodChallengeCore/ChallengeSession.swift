import Foundation

public enum ResponseTransport: String, Sendable {
    case notification
    case readFallback
}

public struct ChallengeResult: Sendable {
    public let attempt: Int
    public let roundTripMilliseconds: Double
    public let transport: ResponseTransport
    public let deviceCounter: UInt32
    public let challenge: DeviceProtocolV0.Challenge
    public let response: DeviceProtocolV0.Response
}

/// Runs three sequential exchanges using caller-provided monotonic timestamps.
public struct ChallengeSession {
    /// The device enforces two seconds between writes when they reach it. Radio
    /// scheduling can shorten that gap on the device side, so add a margin.
    public static let defaultChallengeSpacingSeconds =
        DeviceProtocolV0.minimumChallengeIntervalSeconds + 0.25

    public enum SessionError: Error, Equatable {
        case challengeAlreadyPending
        case noPendingChallenge
        case alreadyComplete
        case reusedNonce
        case invalidClock
        case interrupted
        case timedOut
        case challengeTooSoon
        case nonIncreasingCounter
    }

    public enum Receipt {
        case verified(ChallengeResult)
        case ignoredDuplicate
    }

    public let info: DeviceProtocolV0.Info
    public let challengeSpacingSeconds: Double
    public private(set) var results: [ChallengeResult] = []
    public var isComplete: Bool { results.count == 3 }
    public var hasPendingChallenge: Bool { pending != nil }
    /// Earliest monotonic time for the next write; `nil` before the first one.
    public var nextChallengeAllowedAt: Double? {
        lastStartedAt.map { $0 + challengeSpacingSeconds }
    }

    private var pending: (challenge: DeviceProtocolV0.Challenge, startedAt: Double)?
    private var lastStartedAt: Double?
    private var usedNonces: Set<Data> = []
    private var acceptedResponses: Set<Data> = []
    private var terminalError: SessionError?

    public init(
        info: DeviceProtocolV0.Info,
        challengeSpacingSeconds: Double = ChallengeSession.defaultChallengeSpacingSeconds
    ) {
        self.info = info
        self.challengeSpacingSeconds = challengeSpacingSeconds
    }

    public mutating func beginChallenge(
        nonce: Data,
        observationEpoch: UInt32,
        observationHint: Data,
        startedAt: Double
    ) throws -> Data {
        if let terminalError { throw terminalError }
        guard !isComplete else { throw SessionError.alreadyComplete }
        guard pending == nil else { throw SessionError.challengeAlreadyPending }
        guard startedAt.isFinite else { throw SessionError.invalidClock }
        if let lastStartedAt {
            guard startedAt >= lastStartedAt else { throw SessionError.invalidClock }
            guard startedAt - lastStartedAt >= challengeSpacingSeconds else {
                throw SessionError.challengeTooSoon
            }
        }
        guard !usedNonces.contains(nonce) else { throw SessionError.reusedNonce }
        let challenge = try DeviceProtocolV0.Challenge(
            nonce: nonce, observationEpoch: observationEpoch, observationHint: observationHint
        )
        usedNonces.insert(nonce)
        lastStartedAt = startedAt
        pending = (challenge, startedAt)
        return challenge.wireData()
    }

    public mutating func receive(
        _ wireData: Data,
        at receivedAt: Double,
        via transport: ResponseTransport
    ) throws -> Receipt {
        if let terminalError { throw terminalError }
        if acceptedResponses.contains(wireData) { return .ignoredDuplicate }
        guard let pending else { throw SessionError.noPendingChallenge }
        guard receivedAt.isFinite, receivedAt >= pending.startedAt else {
            throw SessionError.invalidClock
        }
        let response = try DeviceProtocolV0.Response(wireData: wireData)
        try DeviceProtocolV0.verify(response: response, challenge: pending.challenge, info: info)
        // Spec §7.1 E_DEV_COUNTER applies when the device claims capability bit 1.
        if info.capabilitySet.contains(.monotonicCounter) {
            guard response.deviceCounter > (results.last?.deviceCounter ?? 0) else {
                throw SessionError.nonIncreasingCounter
            }
        }
        let result = ChallengeResult(
            attempt: results.count + 1,
            roundTripMilliseconds: (receivedAt - pending.startedAt) * 1_000,
            transport: transport,
            deviceCounter: response.deviceCounter,
            challenge: pending.challenge, response: response
        )
        acceptedResponses.insert(wireData)
        results.append(result)
        self.pending = nil
        return .verified(result)
    }

    public mutating func interrupt() {
        guard terminalError == nil else { return }
        terminalError = .interrupted
        pending = nil
    }

    @discardableResult
    public mutating func expirePending(at now: Double, after seconds: Double) throws -> Bool {
        if let terminalError { throw terminalError }
        guard now.isFinite, seconds.isFinite, seconds > 0 else {
            throw SessionError.invalidClock
        }
        guard let pending else { return false }
        guard now >= pending.startedAt else { throw SessionError.invalidClock }
        guard now - pending.startedAt >= seconds else { return false }
        terminalError = .timedOut
        self.pending = nil
        return true
    }

    /// A median is only comparable across the three attempts if all completed
    /// through notifications. A read fallback includes an additional GATT read.
    public var medianNotificationRTTMilliseconds: Double? {
        guard isComplete, results.allSatisfy({ $0.transport == .notification }) else {
            return nil
        }
        return results.map(\.roundTripMilliseconds).sorted()[1]
    }
}
