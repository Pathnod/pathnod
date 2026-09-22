import Foundation
import PathnodDensityCore
import Testing

// Fixtures shared by the density suites.
//
// The rules below are test material, not documented signatures: they exist to
// exercise matching, priority and conflict handling beyond the app's single
// reviewed Helium rule.
//
// Only public API is exercised, so the suites also compile under
// `swift test -c release`.

/// A clock the tests move by hand, so pause/resume timing is exact and no test
/// ever sleeps.
///
/// Civil time and the monotonic reading are separate values, as they are on a
/// device: ``advance(by:)`` moves both, the way time normally passes, and
/// ``shiftCivilTime(by:)`` moves civil time alone, the way a network
/// correction, a time-zone change or the user editing the date does.
final class TestDensityClock: DensityClock, @unchecked Sendable {
  private var current: Date
  private var reading: TimeInterval

  init(_ start: Date = Date(timeIntervalSince1970: 1_758_499_200)) {
    current = start
    // An origin unrelated to civil time, so a test cannot pass by accident
    // because the two scales happened to coincide.
    reading = 10_000
  }

  var now: Date { current }

  var monotonicSeconds: TimeInterval { reading }

  func advance(by seconds: TimeInterval) {
    current = current.addingTimeInterval(seconds)
    reading += seconds
  }

  /// Moves the device's idea of civil time without any time passing.
  func shiftCivilTime(by seconds: TimeInterval) {
    current = current.addingTimeInterval(seconds)
  }
}

/// A clock that models civil time only, and so takes ``DensityClock``'s default
/// monotonic reading from it.
///
/// It is the worst case the accumulator has to survive: every correction of the
/// device clock looks to it like time passing or unwinding.
final class CivilOnlyClock: DensityClock, @unchecked Sendable {
  var now: Date

  init(_ start: Date = Date(timeIntervalSince1970: 1_000)) {
    now = start
  }
}

/// Deterministic session identifiers, so an export can be compared field by
/// field.
func fixedSessionID(_ lastGroup: String = "000000000001") -> UUID {
  UUID(uuidString: "11111111-2222-3333-4444-\(lastGroup)")!
}

enum TestUUIDs {
  static let heliumService = "F1E2"
  static let evService = "0000E5A1-0000-1000-8000-00805F9B34FB"
  static let unrelatedService = "FEAA"

  /// Services of the contended registry below, one per rule.
  static let contendedHeliumHigh = "F101"
  static let contendedWifiHigh = "F102"
  static let contendedHeliumMedium = "F103"
  static let contendedEVLow = "F104"
  static let contendedEVAbove = "F105"
  static let contendedHeliumHighAlternate = "F106"
}

func serviceUUID(_ value: String) throws -> ServiceUUID {
  try #require(ServiceUUID(value), "expected \(value) to be a valid service UUID")
}

func rule(
  id: String,
  category: DensityCategory,
  confidence: ClassificationConfidence = .high,
  sourceKind: ClassificationSourceKind = .publishedSpec,
  sourceReference: String = "test fixture",
  serviceUUIDs: Set<ServiceUUID> = [],
  manufacturerSignature: ManufacturerSignature? = nil,
  priority: Int
) -> ClassificationRule {
  ClassificationRule(
    id: id,
    category: category,
    confidence: confidence,
    sourceKind: sourceKind,
    sourceReference: sourceReference,
    serviceUUIDs: serviceUUIDs,
    manufacturerSignature: manufacturerSignature,
    priority: priority
  )
}

/// A registry with one service-UUID rule per category plus one manufacturer
/// rule, all at distinct priorities.
func referenceRegistry() throws -> ClassificationRegistry {
  try ClassificationRegistry(
    version: "test-1",
    rules: [
      rule(
        id: "helium-service",
        category: .helium,
        sourceReference: "fixture: helium service UUID",
        serviceUUIDs: [try serviceUUID(TestUUIDs.heliumService)],
        priority: 100
      ),
      rule(
        id: "ev-service",
        category: .ev,
        confidence: .medium,
        sourceKind: .partnerConfirmed,
        sourceReference: "fixture: EV service UUID",
        serviceUUIDs: [try serviceUUID(TestUUIDs.evService)],
        priority: 80
      ),
      rule(
        id: "wifi-manufacturer",
        category: .wifi,
        confidence: .medium,
        sourceReference: "fixture: Wi-Fi manufacturer prefix",
        manufacturerSignature: ManufacturerSignature(
          companyIdentifier: 0x004C,
          dataPrefix: [0x10, 0x20]
        ),
        priority: 10
      ),
    ]
  )
}

/// A registry built to contend: two categories tie at priority 100, a third
/// category sits far below them and a fourth rule sits above, so a session can
/// be shown evidence that is weaker than, equal to and stronger than an
/// ambiguity it already holds.
///
/// `b-wifi-high` deliberately sorts before `c-helium-high` and is no less
/// confident, so a tie-break by confidence or identifier across the two
/// categories would be visible immediately.
func contendedRegistry() throws -> ClassificationRegistry {
  try ClassificationRegistry(
    version: "contended-1",
    rules: [
      rule(
        id: "b-wifi-high",
        category: .wifi,
        serviceUUIDs: [try serviceUUID(TestUUIDs.contendedWifiHigh)],
        priority: 100
      ),
      rule(
        id: "c-helium-high",
        category: .helium,
        serviceUUIDs: [try serviceUUID(TestUUIDs.contendedHeliumHigh)],
        priority: 100
      ),
      rule(
        id: "d-helium-medium",
        category: .helium,
        confidence: .medium,
        serviceUUIDs: [try serviceUUID(TestUUIDs.contendedHeliumMedium)],
        priority: 100
      ),
      rule(
        id: "e-ev-low",
        category: .ev,
        serviceUUIDs: [try serviceUUID(TestUUIDs.contendedEVLow)],
        priority: 1
      ),
      rule(
        id: "f-helium-high",
        category: .helium,
        serviceUUIDs: [try serviceUUID(TestUUIDs.contendedHeliumHighAlternate)],
        priority: 100
      ),
      rule(
        id: "a-ev-above",
        category: .ev,
        serviceUUIDs: [try serviceUUID(TestUUIDs.contendedEVAbove)],
        priority: 200
      ),
    ]
  )
}

func advertisement(
  services: [ServiceUUID] = [],
  manufacturer: ManufacturerData? = nil,
  carriesLocalName: Bool = false
) -> AdvertisementSnapshot {
  AdvertisementSnapshot(
    serviceUUIDs: Set(services),
    manufacturerData: manufacturer,
    carriesLocalName: carriesLocalName
  )
}

extension SessionAccumulator {
  /// Records one sighting and asserts the invariant that must hold after every
  /// single one: the four category counters sum to `uniqueAdvertisers`.
  @discardableResult
  func recordChecked(
    _ peripheral: PeripheralKey,
    _ snapshot: AdvertisementSnapshot
  ) -> ClassificationOutcome? {
    let outcome = record(peripheral: peripheral, advertisement: snapshot)
    let current = summary
    #expect(
      current.classifiedTotal == current.uniqueAdvertisers,
      "category counters must always sum to uniqueAdvertisers"
    )
    return outcome
  }
}
