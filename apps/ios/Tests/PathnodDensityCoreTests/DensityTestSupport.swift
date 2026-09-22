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
final class TestDensityClock: DensityClock, @unchecked Sendable {
  private var current: Date

  init(_ start: Date = Date(timeIntervalSince1970: 1_758_499_200)) {
    current = start
  }

  var now: Date { current }

  func advance(by seconds: TimeInterval) {
    current = current.addingTimeInterval(seconds)
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
