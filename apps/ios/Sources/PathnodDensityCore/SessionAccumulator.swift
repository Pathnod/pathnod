import Foundation

/// The time source a session measures with, injected so tests can drive
/// pause/resume timing without sleeping.
///
/// A session needs two different things from a clock and must not confuse
/// them: a civil date to label the session with, and a duration to measure it
/// with. The device's civil clock can be corrected by the network, by a
/// time-zone change or by the user at any moment, so it is read for the label
/// and never used for the measurement.
public protocol DensityClock: Sendable {
  /// Civil time, for the timestamps an export carries. May jump in either
  /// direction while a session runs.
  var now: Date { get }

  /// A reading in seconds from an arbitrary, fixed origin, used for every
  /// duration a session reports.
  ///
  /// The contract is that it never goes backwards and is unaffected by a
  /// correction of civil time. ``SessionAccumulator`` does not depend on the
  /// contract being honoured — a reading that does move backwards contributes
  /// no time rather than a negative one — but a clock that breaks it can only
  /// under-report.
  ///
  /// There is deliberately no default implementation: a conformer that derived
  /// this from ``now`` without saying so would reintroduce wall-clock durations
  /// silently, so every conformer has to name its duration source.
  var monotonicSeconds: TimeInterval { get }
}

/// The clock every shipped session uses.
public struct SystemDensityClock: DensityClock {
  /// `ContinuousClock` keeps counting while the device is asleep and is moved
  /// by nothing a user, a network or a time zone can do, which is exactly what
  /// a session duration needs. Only differences from this fixed origin are
  /// ever read, so the origin itself is arbitrary.
  private static let origin = ContinuousClock.now

  public init() {}

  public var now: Date { Date() }

  public var monotonicSeconds: TimeInterval {
    let components = (ContinuousClock.now - Self.origin).components
    return TimeInterval(components.seconds)
      + TimeInterval(components.attoseconds) / 1_000_000_000_000_000_000
  }
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
public struct PeripheralKey: Hashable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible
{
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
  /// The civil time the session began at, read once and floored to the second.
  public let startedAt: Date?
  /// `startedAt` advanced by ``wallClockSeconds``, and `nil` until the session
  /// is finished. It is derived rather than read so that the two timestamps and
  /// the two durations cannot disagree; see ``SessionAccumulator`` for why.
  public let endedAt: Date?
  /// Measured from the monotonic reading, never from civil time: Start to Stop,
  /// interruptions included.
  public let wallClockSeconds: Int
  /// The part of ``wallClockSeconds`` that was actually spent scanning.
  public let foregroundScanSeconds: Int
  public let interruptionCount: Int
  public let uniqueAdvertisers: Int
  /// Always carries all four categories, so the totals can be reconciled
  /// without guessing which keys were omitted.
  public let counts: [DensityCategory: Int]
  /// Sorted by rule identifier, with zero-count rows omitted.
  public let byRule: [RuleTally]
  public let advertiserLimit: Int
  public let uncountedSightings: Int

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
    byRule: [RuleTally],
    advertiserLimit: Int = SessionAccumulator.defaultAdvertiserLimit,
    uncountedSightings: Int = 0
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
    self.advertiserLimit = advertiserLimit
    self.uncountedSightings = uncountedSightings
  }

  public var classifiedTotal: Int {
    DensityCategory.allCases.reduce(0) { $0 + (counts[$1] ?? 0) }
  }

  public var reachedAdvertiserLimit: Bool { uncountedSightings > 0 }
}

/// Accumulates one session in memory.
///
/// Invariants held after every call:
///
/// - the four category counters sum to `uniqueAdvertisers`;
/// - `byRule` counts sum to at most `uniqueAdvertisers`, and never include a
///   zero row;
/// - sightings are only counted while the state is `scanning`;
/// - `0 <= foregroundScanSeconds <= wallClockSeconds`.
///
/// ## How a session is timed
///
/// Both durations are measured from ``DensityClock/monotonicSeconds`` and from
/// nothing else. A session is a chain of segments delimited by Start,
/// interrupt, Resume and Stop; each segment contributes its measured length to
/// the wall clock, and the segments that were spent scanning also contribute to
/// the foreground time. Both durations therefore rise together and never
/// decrease, as long as the clock honours its contract.
///
/// A segment whose closing reading is below its opening one contributes zero.
/// That is the whole of what happens when a clock does move backwards: the
/// session under-reports the segment the discontinuity fell in. It never
/// reports a negative duration, never reports scanning for longer than the
/// session lasted, and never gains time it did not measure.
///
/// Civil time is read exactly once per session, at Start, and floored to the
/// second the schema carries. `endedAt` is that one reading advanced by the
/// measured `wallClockSeconds`, so an export always satisfies
/// `endedAt - startedAt == wallClockSeconds` exactly, whatever the device clock
/// did in between. The cost of that rule is stated plainly: a civil-clock
/// correction landing after Start is not reflected in the two timestamps, which
/// stay on the scale the session began on. Both are the device's account of
/// when the session ran; only the durations beside them are a measurement.
///
/// The type is deliberately not `Sendable`: the app drives it from the main
/// actor, and nothing here is persisted, so an interrupted session is lost if
/// iOS terminates the process.
public final class SessionAccumulator {
  public static let defaultAdvertiserLimit = 50_000

  private let classifier: AdvertisementClassifier
  private let clock: any DensityClock
  private let makeSessionID: () -> UUID
  private let advertiserLimit: Int

  public private(set) var state: SessionState = .idle
  public private(set) var sessionID: UUID

  /// The single civil reading of the session, floored to the second the schema
  /// carries so that the exported timestamps and durations agree exactly.
  private var startedAt: Date?
  /// Wall-clock and foreground seconds already closed into the session, and
  /// the monotonic reading the segment still open began at.
  private var closedWallSeconds: TimeInterval = 0
  private var closedForegroundSeconds: TimeInterval = 0
  private var segmentStartedAtReading: TimeInterval?
  /// Whether the open segment is one the user is being credited foreground
  /// scanning for. An interruption keeps the wall clock running and this off.
  private var isScanningSegment = false
  private var interruptionCount = 0

  private var outcomes: [PeripheralKey: ClassificationOutcome] = [:]
  private var categoryCounts: [DensityCategory: Int] = [:]
  private var ruleCounts: [String: Int] = [:]
  private var uncountedSightings = 0

  public init(
    classifier: AdvertisementClassifier,
    clock: any DensityClock = SystemDensityClock(),
    makeSessionID: @escaping () -> UUID = { UUID() },
    advertiserLimit: Int = SessionAccumulator.defaultAdvertiserLimit
  ) {
    self.classifier = classifier
    self.clock = clock
    self.makeSessionID = makeSessionID
    self.advertiserLimit = max(0, advertiserLimit)
    self.sessionID = makeSessionID()
  }

  public var rulesetVersion: String { classifier.registry.version }

  /// Begins a session. Ignored unless the accumulator is idle, so a double
  /// tap cannot restart a running scan or reset its counters.
  public func start() {
    guard state == .idle else { return }
    sessionID = makeSessionID()
    startedAt = Self.flooredToSecond(clock.now)
    closedWallSeconds = 0
    closedForegroundSeconds = 0
    openSegment(scanning: true)
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
    // The wall clock keeps running across an interruption; the foreground
    // clock does not.
    openSegment(scanning: false)
    interruptionCount += 1
    state = .interrupted
  }

  /// Resumes after an explicit user action. Aggregates are preserved.
  public func resume() {
    guard state == .interrupted else { return }
    closeSegment()
    openSegment(scanning: true)
    state = .scanning
  }

  /// Finalises the session; afterwards nothing is counted any more.
  public func finish() {
    guard state == .scanning || state == .interrupted else { return }
    // `closeSegment` leaves no segment open, so a finished session stops
    // advancing however long the clock runs on.
    closeSegment()
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
    segmentStartedAtReading = nil
    isScanningSegment = false
    closedWallSeconds = 0
    closedForegroundSeconds = 0
    interruptionCount = 0
    outcomes.removeAll()
    categoryCounts.removeAll()
    ruleCounts.removeAll()
    uncountedSightings = 0
  }

  /// Records one sighting.
  ///
  /// Returns the outcome now attributed to the peripheral, or `nil` when the
  /// sighting was ignored because no scan is running. A repeated sighting of a
  /// known peripheral never changes `uniqueAdvertisers`; it is merged into the
  /// evidence already held for that peripheral, which can sharpen its category,
  /// leave it alone, or reveal that two categories contend for it.
  @discardableResult
  public func record(
    peripheral: PeripheralKey,
    advertisement: AdvertisementSnapshot
  ) -> ClassificationOutcome? {
    guard state == .scanning else { return nil }

    let sighting = classifier.classify(advertisement)
    guard let existing = outcomes[peripheral] else {
      guard outcomes.count < advertiserLimit else {
        if uncountedSightings < Int.max { uncountedSightings += 1 }
        return nil
      }
      outcomes[peripheral] = sighting
      apply(sighting, delta: 1)
      return sighting
    }

    let merged = existing.merging(sighting)
    guard merged != existing else { return existing }
    apply(existing, delta: -1)
    outcomes[peripheral] = merged
    apply(merged, delta: 1)
    return merged
  }

  public var uniqueAdvertisers: Int { outcomes.count }

  public var summary: SessionSummary {
    let openSeconds = openSegmentSeconds()
    let wallSeconds = Self.wholeSeconds(closedWallSeconds + openSeconds)
    let foregroundSeconds = Self.wholeSeconds(
      closedForegroundSeconds + (isScanningSegment ? openSeconds : 0)
    )

    var counts: [DensityCategory: Int] = [:]
    for category in DensityCategory.allCases {
      counts[category] = categoryCounts[category] ?? 0
    }

    let tallies =
      ruleCounts
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
      endedAt: endedAt(wallClockSeconds: wallSeconds),
      wallClockSeconds: wallSeconds,
      foregroundScanSeconds: foregroundSeconds,
      interruptionCount: interruptionCount,
      uniqueAdvertisers: outcomes.count,
      counts: counts,
      byRule: tallies,
      advertiserLimit: advertiserLimit,
      uncountedSightings: uncountedSightings
    )
  }

  /// The end of the session on the civil scale it began on: the one reading
  /// taken at Start, advanced by the whole seconds actually measured. `nil`
  /// until the session is finished, because an export must not carry an end
  /// for a session that has not got one.
  private func endedAt(wallClockSeconds: Int) -> Date? {
    guard state == .finished, let startedAt else { return nil }
    return startedAt.addingTimeInterval(TimeInterval(wallClockSeconds))
  }

  /// How long the open segment has been running. A reading below the one the
  /// segment opened at means the clock broke its contract; the segment then
  /// contributes nothing rather than a negative duration.
  private func openSegmentSeconds() -> TimeInterval {
    guard let segmentStartedAtReading else { return 0 }
    return max(0, clock.monotonicSeconds - segmentStartedAtReading)
  }

  private func openSegment(scanning: Bool) {
    segmentStartedAtReading = clock.monotonicSeconds
    isScanningSegment = scanning
  }

  private func closeSegment() {
    let seconds = openSegmentSeconds()
    closedWallSeconds += seconds
    if isScanningSegment {
      closedForegroundSeconds += seconds
    }
    segmentStartedAtReading = nil
    isScanningSegment = false
  }

  private func apply(_ outcome: ClassificationOutcome, delta: Int) {
    categoryCounts[outcome.category, default: 0] += delta
    if let ruleID = outcome.ruleID {
      ruleCounts[ruleID, default: 0] += delta
    }
  }

  /// The schema carries whole seconds, so a measured duration is truncated
  /// towards zero. Segments are already non-negative and finite; the guard is
  /// there so that arithmetic on a nonsensical reading still yields a number an
  /// export can reconcile.
  private static func wholeSeconds(_ interval: TimeInterval) -> Int {
    guard interval > 0, interval.isFinite else { return 0 }
    return Int(interval)
  }

  /// Drops the sub-second part of the civil reading. The schema states
  /// timestamps to the second, and flooring here rather than in the formatter
  /// keeps `endedAt - startedAt` equal to `wallClockSeconds` in the file.
  private static func flooredToSecond(_ date: Date) -> Date {
    Date(timeIntervalSinceReferenceDate: date.timeIntervalSinceReferenceDate.rounded(.down))
  }
}
