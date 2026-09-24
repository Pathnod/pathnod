import Foundation

/// Why an export was refused.
///
/// Every case is a refusal, never a partial file: an export that cannot be
/// reconciled is a bug in the accumulator, and writing it anyway would publish
/// numbers nobody can check.
public enum DensityExportError: Error, Equatable, Sendable {
  case sessionNotFinished(SessionState)
  case missingStartTimestamp
  case missingEndTimestamp
  case endedBeforeStart
  case foregroundExceedsWallClock(foregroundScanSeconds: Int, wallClockSeconds: Int)
  case emptyApplicationVersion
  case categoryCountsDoNotReconcile(uniqueAdvertisers: Int, categoryTotal: Int)
  case ruleCountsDoNotReconcile(ruleTotal: Int, classifiedTotal: Int)
  case zeroCountRuleRow(ruleID: String)
  case negativeValue(field: String)
  case advertiserLimitExceeded(uniqueAdvertisers: Int, advertiserLimit: Int)
  case encodingFailed(String)
}

/// The four category counters, as fixed JSON keys rather than a dictionary, so
/// a reader never has to guess whether a missing key means zero.
public struct DensityExportCounts: Codable, Hashable, Sendable {
  public let helium: Int
  public let wifi: Int
  public let ev: Int
  public let unknown: Int

  public init(helium: Int, wifi: Int, ev: Int, unknown: Int) {
    self.helium = helium
    self.wifi = wifi
    self.ev = ev
    self.unknown = unknown
  }

  init(_ counts: [DensityCategory: Int]) {
    self.init(
      helium: counts[.helium] ?? 0,
      wifi: counts[.wifi] ?? 0,
      ev: counts[.ev] ?? 0,
      unknown: counts[.unknown] ?? 0
    )
  }

  public var total: Int { helium + wifi + ev + unknown }

  /// Everything a rule could have contributed to. `unknown` is never rule
  /// attributed: it is the absence of a match, or an ambiguous one.
  public var classifiedTotal: Int { helium + wifi + ev }
}

/// One aggregate row. The rule, its provenance and how many distinct
/// advertisers it accounted for — never which ones.
public struct DensityExportRuleRow: Codable, Hashable, Sendable {
  public let ruleId: String
  public let category: DensityCategory
  public let confidence: ClassificationConfidence
  public let sourceKind: ClassificationSourceKind
  public let sourceReference: String
  public let count: Int

  public init(
    ruleId: String,
    category: DensityCategory,
    confidence: ClassificationConfidence,
    sourceKind: ClassificationSourceKind,
    sourceReference: String,
    count: Int
  ) {
    self.ruleId = ruleId
    self.category = category
    self.confidence = confidence
    self.sourceKind = sourceKind
    self.sourceReference = sourceReference
    self.count = count
  }

  init(_ tally: RuleTally) {
    self.init(
      ruleId: tally.ruleID,
      category: tally.category,
      confidence: tally.confidence,
      sourceKind: tally.sourceKind,
      sourceReference: tally.sourceReference,
      count: tally.count
    )
  }
}

/// Schema v1 of the density export.
///
/// The stored properties *are* the schema: `Codable` synthesis means a field
/// that is not declared here cannot appear in the file, and the type declares no
/// peripheral identifier, local name, address, manufacturer payload, service
/// data, raw advertisement, per-device row, or location field of any kind.
///
/// `startedAt` and `endedAt` are two points on one civil scale, read once at
/// the start of the session; the durations beside them are measured
/// monotonically. A reader can therefore rely on
/// `endedAt - startedAt == wallClockSeconds` and on
/// `foregroundScanSeconds <= wallClockSeconds` in every file, and should read
/// the timestamps as the device's idea of when the session ran rather than as
/// the measurement itself. ``SessionAccumulator`` documents the rule in full.
public struct DensityExportV1: Codable, Hashable, Sendable {
  public static let currentSchemaVersion = 1

  /// The only scan mode this app implements: a generic, unfiltered,
  /// foreground CoreBluetooth scan.
  public static let foregroundScanMode = "foreground-generic-ble"

  /// Carried in every file so an aggregate cannot be quoted without them.
  public static let requiredLimitations: [String] = [
    "Counts only BLE advertisers that CoreBluetooth reported while this app was in the foreground; anything not advertising, out of range, or seen while the app was interrupted is missing.",
    "A rule match means the advertisement carried a documented signature. It is not verified network membership, ownership, online status, or hardware identification.",
    "No location, coordinate, geohash, Wi-Fi network, device identifier, device name, address, or raw advertising payload was collected or exported.",
  ]

  public static func advertiserLimitLimitation(
    advertiserLimit: Int,
    uncountedSightings: Int
  ) -> String {
    "This session reached its bound of \(advertiserLimit) retained advertiser identities. \(uncountedSightings) later sightings from identities not already retained were discarded. uniqueAdvertisers and category counts are therefore a floor, not a complete total."
  }

  public let schemaVersion: Int
  public let sessionId: String
  public let scanMode: String
  public let rulesetVersion: String
  public let appVersion: String
  public let startedAt: String
  public let endedAt: String
  public let wallClockSeconds: Int
  public let foregroundScanSeconds: Int
  public let interruptionCount: Int
  public let uniqueAdvertisers: Int
  public let counts: DensityExportCounts
  public let byRule: [DensityExportRuleRow]
  public let limitations: [String]

  public init(
    schemaVersion: Int = DensityExportV1.currentSchemaVersion,
    sessionId: String,
    scanMode: String = DensityExportV1.foregroundScanMode,
    rulesetVersion: String,
    appVersion: String,
    startedAt: String,
    endedAt: String,
    wallClockSeconds: Int,
    foregroundScanSeconds: Int,
    interruptionCount: Int,
    uniqueAdvertisers: Int,
    counts: DensityExportCounts,
    byRule: [DensityExportRuleRow],
    limitations: [String] = DensityExportV1.requiredLimitations
  ) {
    self.schemaVersion = schemaVersion
    self.sessionId = sessionId
    self.scanMode = scanMode
    self.rulesetVersion = rulesetVersion
    self.appVersion = appVersion
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.wallClockSeconds = wallClockSeconds
    self.foregroundScanSeconds = foregroundScanSeconds
    self.interruptionCount = interruptionCount
    self.uniqueAdvertisers = uniqueAdvertisers
    self.counts = counts
    self.byRule = byRule
    self.limitations = limitations
  }
}

/// Builds and encodes schema-v1 exports.
public enum DensityExport {
  /// RFC 3339 in UTC, second resolution, independent of the device locale and
  /// time zone: `2026-09-22T09:41:00Z`.
  public static func rfc3339UTC(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }

  /// Turns a finished session into an export, refusing anything that does not
  /// reconcile.
  public static func makeDocument(
    from summary: SessionSummary,
    appVersion: String
  ) throws -> DensityExportV1 {
    guard summary.state == .finished else {
      throw DensityExportError.sessionNotFinished(summary.state)
    }
    guard let startedAt = summary.startedAt else {
      throw DensityExportError.missingStartTimestamp
    }
    guard let endedAt = summary.endedAt else {
      throw DensityExportError.missingEndTimestamp
    }
    guard endedAt >= startedAt else {
      throw DensityExportError.endedBeforeStart
    }

    let trimmedAppVersion = appVersion.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedAppVersion.isEmpty else {
      throw DensityExportError.emptyApplicationVersion
    }

    for (field, value) in [
      ("wallClockSeconds", summary.wallClockSeconds),
      ("foregroundScanSeconds", summary.foregroundScanSeconds),
      ("interruptionCount", summary.interruptionCount),
      ("uniqueAdvertisers", summary.uniqueAdvertisers),
      ("advertiserLimit", summary.advertiserLimit),
      ("uncountedSightings", summary.uncountedSightings),
    ] where value < 0 {
      throw DensityExportError.negativeValue(field: field)
    }

    guard summary.uniqueAdvertisers <= summary.advertiserLimit else {
      throw DensityExportError.advertiserLimitExceeded(
        uniqueAdvertisers: summary.uniqueAdvertisers,
        advertiserLimit: summary.advertiserLimit
      )
    }

    // Scanning is a part of the session, so it cannot outlast it. The
    // accumulator measures both durations from the same monotonic readings and
    // cannot break this; the check is here so that a duration nobody can
    // reconcile is refused rather than published.
    guard summary.foregroundScanSeconds <= summary.wallClockSeconds else {
      throw DensityExportError.foregroundExceedsWallClock(
        foregroundScanSeconds: summary.foregroundScanSeconds,
        wallClockSeconds: summary.wallClockSeconds
      )
    }

    let counts = DensityExportCounts(summary.counts)
    guard counts.total == summary.uniqueAdvertisers else {
      throw DensityExportError.categoryCountsDoNotReconcile(
        uniqueAdvertisers: summary.uniqueAdvertisers,
        categoryTotal: counts.total
      )
    }

    // Zero rows are omitted, so a reader cannot mistake "no rule matched" for
    // "this rule was evaluated and found nothing".
    for tally in summary.byRule where tally.count <= 0 {
      throw DensityExportError.zeroCountRuleRow(ruleID: tally.ruleID)
    }

    let ruleTotal = summary.byRule.reduce(0) { $0 + $1.count }
    guard ruleTotal == counts.classifiedTotal else {
      throw DensityExportError.ruleCountsDoNotReconcile(
        ruleTotal: ruleTotal,
        classifiedTotal: counts.classifiedTotal
      )
    }

    var limitations = DensityExportV1.requiredLimitations
    if summary.reachedAdvertiserLimit {
      limitations.append(
        DensityExportV1.advertiserLimitLimitation(
          advertiserLimit: summary.advertiserLimit,
          uncountedSightings: summary.uncountedSightings
        )
      )
    }

    return DensityExportV1(
      sessionId: summary.sessionID.uuidString,
      rulesetVersion: summary.rulesetVersion,
      appVersion: trimmedAppVersion,
      startedAt: rfc3339UTC(startedAt),
      endedAt: rfc3339UTC(endedAt),
      wallClockSeconds: summary.wallClockSeconds,
      foregroundScanSeconds: summary.foregroundScanSeconds,
      interruptionCount: summary.interruptionCount,
      uniqueAdvertisers: summary.uniqueAdvertisers,
      counts: counts,
      byRule: summary.byRule.map { DensityExportRuleRow($0) },
      limitations: limitations
    )
  }

  /// UTF-8 JSON. Keys are sorted and the output is pretty printed so two runs
  /// of the same session produce byte-identical files and a reviewer can read
  /// one without a tool.
  public static func encode(_ document: DensityExportV1) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
    do {
      return try encoder.encode(document)
    } catch {
      throw DensityExportError.encodingFailed(String(describing: error))
    }
  }

  /// Convenience for the app: validate, then encode.
  public static func makeJSON(
    from summary: SessionSummary,
    appVersion: String
  ) throws -> Data {
    try encode(makeDocument(from: summary, appVersion: appVersion))
  }

  /// A stable, identifier-free file name. The session identifier is random and
  /// generated per session; it is not derived from the device or from any
  /// peripheral.
  public static func fileName(for document: DensityExportV1) -> String {
    "pathnod-density-\(document.sessionId).json"
  }
}
