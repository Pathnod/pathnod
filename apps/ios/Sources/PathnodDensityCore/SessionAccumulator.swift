import Foundation

/// The time source a session measures with, injected so tests can drive
/// pause/resume timing without sleeping.
public protocol DensityClock: Sendable {
    var now: Date { get }
}

public struct SystemDensityClock: DensityClock {
    public init() {}

    public var now: Date { Date() }
}

/// The lifecycle of one foreground session.
///
/// There is no state in which scanning continues outside the foreground:
/// `interrupted` is only left through an explicit ``SessionAccumulator/resume()``.
public enum SessionState: String, Sendable {
    case idle
    case scanning
    case interrupted
    case finished
}

/// An ephemeral, in-memory deduplication key.
///
/// The app wraps `CBPeripheral.identifier` in this type and nothing else. The
/// wrapped value is private, the type is not `Codable`, and its descriptions
/// are redacted, so a peripheral identifier cannot be persisted, logged,
/// displayed, hashed for export, or exported by accident.
public struct PeripheralKey: Hashable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    private let value: UUID

    public init(_ value: UUID) {
        self.value = value
    }

    public var description: String { "PeripheralKey(redacted)" }

    public var debugDescription: String { description }
}

/// One aggregate rule row: no device ever appears individually.
public struct RuleTally: Hashable, Sendable {
    public let ruleID: String
    public let category: DensityCategory
    public let confidence: ClassificationConfidence
    public let sourceKind: ClassificationSourceKind
    public let sourceReference: String
    public let count: Int

    public init(
        ruleID: String,
        category: DensityCategory,
        confidence: ClassificationConfidence,
        sourceKind: ClassificationSourceKind,
        sourceReference: String,
        count: Int
    ) {
        self.ruleID = ruleID
        self.category = category
        self.confidence = confidence
        self.sourceKind = sourceKind
        self.sourceReference = sourceReference
        self.count = count
    }
}

/// The complete, privacy-safe picture of a session at one instant.
public struct SessionSummary: Hashable, Sendable {
    public let sessionID: UUID
    public let rulesetVersion: String
    public let state: SessionState
    public let startedAt: Date?
    public let endedAt: Date?
    public let wallClockSeconds: Int
    public let foregroundScanSeconds: Int
    public let interruptionCount: Int
    public let uniqueAdvertisers: Int
    /// Always carries all four categories, so the totals can be reconciled
    /// without guessing which keys were omitted.
    public let counts: [DensityCategory: Int]
    /// Sorted by rule identifier, with zero-count rows omitted.
    public let byRule: [RuleTally]

    public init(
        sessionID: UUID,
        rulesetVersion: String,
        state: SessionState,
        startedAt: Date?,
        endedAt: Date?,
        wallClockSeconds: Int,
        foregroundScanSeconds: Int,
        interruptionCount: Int,
        uniqueAdvertisers: Int,
        counts: [DensityCategory: Int],
        byRule: [RuleTally]
    ) {
        self.sessionID = sessionID
        self.rulesetVersion = rulesetVersion
        self.state = state
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.wallClockSeconds = wallClockSeconds
        self.foregroundScanSeconds = foregroundScanSeconds
        self.interruptionCount = interruptionCount
        self.uniqueAdvertisers = uniqueAdvertisers
        self.counts = counts
        self.byRule = byRule
    }

    public var classifiedTotal: Int {
        DensityCategory.allCases.reduce(0) { $0 + (counts[$1] ?? 0) }
    }
}

/// Accumulates one session in memory.
///
/// Invariants held after every call:
///
/// - the four category counters sum to `uniqueAdvertisers`;
/// - `byRule` counts sum to at most `uniqueAdvertisers`, and never include a
///   zero row;
/// - sightings are only counted while the state is `scanning`.
///
/// The type is deliberately not `Sendable`: the app drives it from the main
/// actor, and nothing here is persisted, so an interrupted session is lost if
/// iOS terminates the process.
public final class SessionAccumulator {
    private let classifier: AdvertisementClassifier
    private let clock: any DensityClock
    private let makeSessionID: () -> UUID

    public private(set) var state: SessionState = .idle
    public private(set) var sessionID: UUID
    private var startedAt: Date?
    private var endedAt: Date?
    private var segmentStartedAt: Date?
    private var foregroundSeconds: TimeInterval = 0
    private var interruptionCount = 0

    private var outcomes: [PeripheralKey: ClassificationOutcome] = [:]
    private var categoryCounts: [DensityCategory: Int] = [:]
    private var ruleCounts: [String: Int] = [:]

    public init(
        classifier: AdvertisementClassifier,
        clock: any DensityClock = SystemDensityClock(),
        makeSessionID: @escaping () -> UUID = { UUID() }
    ) {
        self.classifier = classifier
        self.clock = clock
        self.makeSessionID = makeSessionID
        self.sessionID = makeSessionID()
    }

    public var rulesetVersion: String { classifier.registry.version }

    /// Begins a session. Ignored unless the accumulator is idle, so a double
    /// tap cannot restart a running scan or reset its counters.
    public func start() {
        guard state == .idle else { return }
        let now = clock.now
        sessionID = makeSessionID()
        startedAt = now
        endedAt = nil
        segmentStartedAt = now
        state = .scanning
    }

    /// Records that the foreground scan stopped: the app left the foreground,
    /// the screen locked, Bluetooth became unavailable, or the user paused.
    ///
    /// Only a running scan can be interrupted, so repeated lifecycle callbacks
    /// cannot inflate the interruption count.
    public func interrupt() {
        guard state == .scanning else { return }
        closeSegment()
        interruptionCount += 1
        state = .interrupted
    }

    /// Resumes after an explicit user action. Aggregates are preserved.
    public func resume() {
        guard state == .interrupted else { return }
        segmentStartedAt = clock.now
        state = .scanning
    }

    /// Finalises the session; afterwards nothing is counted any more.
    public func finish() {
        guard state == .scanning || state == .interrupted else { return }
        closeSegment()
        endedAt = clock.now
        state = .finished
    }

    /// Drops every sighting, timer and counter and returns to `idle`. Used by
    /// Delete and by New session.
    ///
    /// The session identifier is regenerated here as well: after Delete nothing
    /// of the previous session survives, not even the random value that labelled
    /// its export.
    public func reset() {
        state = .idle
        sessionID = makeSessionID()
        startedAt = nil
        endedAt = nil
        segmentStartedAt = nil
        foregroundSeconds = 0
        interruptionCount = 0
        outcomes.removeAll()
        categoryCounts.removeAll()
        ruleCounts.removeAll()
    }

    /// Records one sighting.
    ///
    /// Returns the outcome now attributed to the peripheral, or `nil` when the
    /// sighting was ignored because no scan is running. A repeated sighting of
    /// a known peripheral never changes `uniqueAdvertisers`; it can only move
    /// that peripheral to a stronger category.
    @discardableResult
    public func record(
        peripheral: PeripheralKey,
        advertisement: AdvertisementSnapshot
    ) -> ClassificationOutcome? {
        guard state == .scanning else { return nil }

        let outcome = classifier.classify(advertisement)
        guard let existing = outcomes[peripheral] else {
            outcomes[peripheral] = outcome
            apply(outcome, delta: 1)
            return outcome
        }

        guard outcome.supersedes(existing) else { return existing }
        apply(existing, delta: -1)
        outcomes[peripheral] = outcome
        apply(outcome, delta: 1)
        return outcome
    }

    public var uniqueAdvertisers: Int { outcomes.count }

    public var summary: SessionSummary {
        let now = clock.now
        let elapsed = startedAt.map { (endedAt ?? now).timeIntervalSince($0) } ?? 0
        var counts: [DensityCategory: Int] = [:]
        for category in DensityCategory.allCases {
            counts[category] = categoryCounts[category] ?? 0
        }

        let tallies = ruleCounts
            .filter { $0.value > 0 }
            .compactMap { id, count -> RuleTally? in
                guard let rule = classifier.registry.rule(id: id) else { return nil }
                return RuleTally(
                    ruleID: rule.id,
                    category: rule.category,
                    confidence: rule.confidence,
                    sourceKind: rule.sourceKind,
                    sourceReference: rule.sourceReference,
                    count: count
                )
            }
            .sorted { $0.ruleID < $1.ruleID }

        return SessionSummary(
            sessionID: sessionID,
            rulesetVersion: classifier.registry.version,
            state: state,
            startedAt: startedAt,
            endedAt: endedAt,
            wallClockSeconds: Self.wholeSeconds(elapsed),
            foregroundScanSeconds: Self.wholeSeconds(foregroundSeconds + openSegmentSeconds(now: now)),
            interruptionCount: interruptionCount,
            uniqueAdvertisers: outcomes.count,
            counts: counts,
            byRule: tallies
        )
    }

    private func openSegmentSeconds(now: Date) -> TimeInterval {
        guard let segmentStartedAt else { return 0 }
        return now.timeIntervalSince(segmentStartedAt)
    }

    private func closeSegment() {
        foregroundSeconds += openSegmentSeconds(now: clock.now)
        segmentStartedAt = nil
    }

    private func apply(_ outcome: ClassificationOutcome, delta: Int) {
        categoryCounts[outcome.category, default: 0] += delta
        if let ruleID = outcome.ruleID {
            ruleCounts[ruleID, default: 0] += delta
        }
    }

    /// Truncates towards zero and floors at zero: a clock that moved backwards
    /// must not produce a negative duration in an export.
    private static func wholeSeconds(_ interval: TimeInterval) -> Int {
        guard interval > 0, interval.isFinite else { return 0 }
        return Int(interval)
    }
}
