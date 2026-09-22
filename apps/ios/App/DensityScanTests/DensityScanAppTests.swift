import CoreBluetooth
import Foundation
import PathnodDensityCore
import Testing

@testable import PathnodDensityScan

// Covers the app layer that the Foundation-only package cannot reach: the
// shipped ruleset, the advertisement narrowing that runs against a real
// `CBAdvertisementData*` dictionary, the export cache and the bundle
// configuration.
//
// Scanning itself is not covered here. A simulator has no BLE radio, so the
// permission flow, the discovery callbacks and the lifecycle interruptions are
// only established by the physical-device matrix.

@Suite("Shipped ruleset")
struct ClassificationRulesTests {
  /// The documented Helium Hotspot configuration service, spelled the way the
  /// source publishes it. Comparing against a literal here means a typo in the
  /// rule is a failing test rather than a silent no-match in the field.
  static let heliumConfigurationServiceUUID = "0fda92b2-44a2-4af2-84f5-fa682baa2b8d"

  @Test("the shipped ruleset is accepted by the registry")
  func registryBuilds() throws {
    let registry = try ClassificationRules.makeRegistry()

    #expect(registry.version == ClassificationRules.version)
    #expect(registry.rules.count == ClassificationRules.candidates.count)
  }

  @Test("this build ships exactly one rule, for Helium")
  func shipsOnlyTheHeliumRule() throws {
    let registry = try ClassificationRules.makeRegistry()

    #expect(registry.rules.map(\.id) == ["helium-hotspot-config-service-v1"])

    let rule = try #require(registry.rule(id: "helium-hotspot-config-service-v1"))
    let expected = try #require(ServiceUUID(Self.heliumConfigurationServiceUUID))

    #expect(rule.category == .helium)
    #expect(rule.confidence == .high)
    #expect(rule.sourceKind == .publishedSpec)
    #expect(rule.priority == 100)
    #expect(rule.serviceUUIDs == [expected])
    #expect(rule.manufacturerSignature == nil)
  }

  @Test("no Wi-Fi or EV signature is claimed")
  func shipsNoWifiOrEVRule() throws {
    let registry = try ClassificationRules.makeRegistry()

    #expect(registry.rules.contains { $0.category == .wifi } == false)
    #expect(registry.rules.contains { $0.category == .ev } == false)
    // No rule needs manufacturer bytes, so none are ever read.
    #expect(registry.inspectedCompanyIdentifiers.isEmpty)
  }

  @Test("the Helium rule matches its service UUID in any spelling")
  func matchesTheDocumentedService() throws {
    let classifier = AdvertisementClassifier(registry: try ClassificationRules.makeRegistry())
    let service = try #require(ServiceUUID(Self.heliumConfigurationServiceUUID.uppercased()))

    let outcome = classifier.classify(AdvertisementSnapshot(serviceUUIDs: [service]))

    #expect(outcome.category == .helium)
    #expect(outcome.ruleID == "helium-hotspot-config-service-v1")
    #expect(outcome.reason == .matched)
  }

  @Test("anything else stays unknown")
  func everythingElseIsUnknown() throws {
    let classifier = AdvertisementClassifier(registry: try ClassificationRules.makeRegistry())

    let outcome = classifier.classify(
      AdvertisementSnapshot(
        serviceUUIDs: Set([ServiceUUID("180A")].compactMap { $0 }),
        manufacturerData: ManufacturerData(companyIdentifier: 0x004C, payload: [0x01]),
        carriesLocalName: true
      )
    )

    #expect(outcome.category == .unknown)
    #expect(outcome.reason == .noMatch)
  }

  @Test("every shipped rule carries a written source reference")
  func everyRuleIsDocumented() {
    for candidate in ClassificationRules.candidates {
      #expect(
        candidate.sourceReference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
      #expect(candidate.category != .unknown)
      #expect(candidate.serviceUUIDs.isEmpty == false || candidate.manufacturerSignature != nil)
    }
  }

  /// The three limits the rule documentation commits to, in the words the
  /// reference actually uses. They travel into every export, so the wording is
  /// part of what the study publishes and is compared literally.
  @Test(
    "the source reference states what a match does not prove",
    arguments: [
      "https://",
      "advertised only while a hotspot offers configuration",
      "can be spoofed",
      "not evidence of network membership, activity, ownership or location",
    ])
  func sourceReferenceStatesItsLimits(_ expected: String) {
    let reference = ClassificationRules.heliumConfigurationService.sourceReference
      .lowercased()
      .replacingOccurrences(of: "\n", with: " ")

    #expect(reference.contains(expected), "the source reference must state: \(expected)")
  }
}

@Suite("Advertisement narrowing")
struct AdvertisementNarrowingTests {
  private func registry() throws -> ClassificationRegistry {
    try ClassificationRegistry(
      version: "app-test-1",
      rules: [
        ClassificationRule(
          id: "service-rule",
          category: .helium,
          confidence: .high,
          sourceKind: .publishedSpec,
          sourceReference: "app test fixture",
          serviceUUIDs: Set([ServiceUUID("F1E2")].compactMap { $0 }),
          priority: 100
        ),
        ClassificationRule(
          id: "manufacturer-rule",
          category: .wifi,
          confidence: .medium,
          sourceKind: .partnerConfirmed,
          sourceReference: "app test fixture",
          manufacturerSignature: ManufacturerSignature(
            companyIdentifier: 0x004C,
            dataPrefix: [0x10, 0x20]
          ),
          priority: 10
        ),
      ]
    )
  }

  @Test("reads the service UUIDs a rule declares, in any CoreBluetooth spelling")
  func readsDeclaredServiceUUIDs() throws {
    let snapshot = BLEScanController.snapshot(
      from: [
        CBAdvertisementDataServiceUUIDsKey: [
          CBUUID(string: "F1E2"),
          CBUUID(string: "0000FEAA-0000-1000-8000-00805F9B34FB"),
        ]
      ],
      registry: try registry()
    )

    let expected = try #require(ServiceUUID("F1E2"))
    #expect(snapshot.serviceUUIDs.contains(expected))
    #expect(snapshot.serviceUUIDs.count == 2)
  }

  @Test("keeps only the manufacturer bytes a rule declares")
  func narrowsManufacturerBytes() throws {
    let snapshot = BLEScanController.snapshot(
      from: [
        CBAdvertisementDataManufacturerDataKey: Data([0x4C, 0x00, 0x10, 0x20, 0xDE, 0xAD])
      ],
      registry: try registry()
    )

    let manufacturer = try #require(snapshot.manufacturerData)
    #expect(manufacturer.companyIdentifier == 0x004C)
    #expect(manufacturer.payload == [0x10, 0x20])
  }

  @Test("a large manufacturer suffix never enters the narrowed snapshot")
  func largeManufacturerSuffixIsNotCopied() throws {
    var bytes = Data([0x4C, 0x00, 0x10, 0x20])
    bytes.append(contentsOf: repeatElement(UInt8(0xA5), count: 64 * 1_024))

    let snapshot = BLEScanController.snapshot(
      from: [CBAdvertisementDataManufacturerDataKey: bytes],
      registry: try registry()
    )

    let manufacturer = try #require(snapshot.manufacturerData)
    #expect(manufacturer.companyIdentifier == 0x004C)
    #expect(manufacturer.payload == [0x10, 0x20])
    #expect(manufacturer.payload.count == 2)
  }

  @Test("ignores manufacturer data for a company no rule declares")
  func ignoresUndeclaredCompany() throws {
    let snapshot = BLEScanController.snapshot(
      from: [CBAdvertisementDataManufacturerDataKey: Data([0x99, 0x00, 0x10, 0x20])],
      registry: try registry()
    )

    #expect(snapshot.manufacturerData == nil)
  }

  @Test("does not inspect a local name because no active rule needs it")
  func ignoresLocalNameCompletely() throws {
    let withName = BLEScanController.snapshot(
      from: [CBAdvertisementDataLocalNameKey: "Someone's headphones"],
      registry: try registry()
    )
    let withoutName = BLEScanController.snapshot(from: [:], registry: try registry())

    #expect(withName.carriesLocalName == false)
    #expect(withoutName.carriesLocalName == false)
    #expect(String(describing: withName).contains("headphones") == false)
  }

  @Test("the shipped ruleset reads service UUIDs and nothing else")
  func shippedRulesetReadsOnlyServiceUUIDs() throws {
    let snapshot = BLEScanController.snapshot(
      from: [
        CBAdvertisementDataServiceUUIDsKey: [
          CBUUID(string: ClassificationRulesTests.heliumConfigurationServiceUUID)
        ],
        CBAdvertisementDataManufacturerDataKey: Data([0x4C, 0x00, 0x10, 0x20]),
        CBAdvertisementDataLocalNameKey: "Someone's headphones",
        CBAdvertisementDataTxPowerLevelKey: NSNumber(value: 4),
        CBAdvertisementDataIsConnectable: NSNumber(value: true),
      ],
      registry: try ClassificationRules.makeRegistry()
    )

    let helium = try #require(ServiceUUID(ClassificationRulesTests.heliumConfigurationServiceUUID))
    #expect(snapshot.serviceUUIDs == [helium])
    // No shipped rule declares a company identifier, so manufacturer bytes
    // are never parsed, whoever sent them.
    #expect(snapshot.manufacturerData == nil)
    #expect(snapshot.carriesLocalName == false)
    #expect(String(describing: snapshot).contains("headphones") == false)
  }

  @Test("a fallback registry never reads anything either")
  func fallbackRegistryReadsNothing() {
    let snapshot = BLEScanController.snapshot(
      from: [
        CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: "F1E2")],
        CBAdvertisementDataManufacturerDataKey: Data([0x4C, 0x00, 0x10, 0x20]),
      ],
      registry: .unavailable
    )

    #expect(snapshot.serviceUUIDs.isEmpty)
    #expect(snapshot.manufacturerData == nil)
  }
}

/// A cache directory belonging to one test and to nothing else.
///
/// Both a store and a controller clear their whole export subdirectory — the
/// controller does it the moment it is created — and Swift Testing runs tests
/// in parallel by default. Marking a suite `.serialized` would not help,
/// because that trait orders a suite's own tests and not the suites beside it,
/// so two tests sharing the app's real caches directory would delete each
/// other's files. Every test that touches a store therefore works in a
/// directory nobody else knows the name of.
private struct TemporaryExportCache {
  let container: URL
  let store: DensityExportStore

  init() {
    container = FileManager.default.temporaryDirectory
      .appendingPathComponent("DensityScanTests-\(UUID().uuidString)", isDirectory: true)
    store = DensityExportStore(container: container)
  }

  /// Removes the whole directory, including anything a failing test left in it.
  func remove() {
    try? FileManager.default.removeItem(at: container)
  }
}

@Suite("Export cache")
struct DensityExportStoreTests {
  @Test("writing replaces any previous export and clearing removes it")
  func writeThenClear() throws {
    let cache = TemporaryExportCache()
    defer { cache.remove() }

    let first = try cache.store.write(Data("{}".utf8), named: "pathnod-density-first.json")
    #expect(FileManager.default.fileExists(atPath: first.path))

    let second = try cache.store.write(Data("{}".utf8), named: "pathnod-density-second.json")
    #expect(FileManager.default.fileExists(atPath: second.path))
    #expect(FileManager.default.fileExists(atPath: first.path) == false)

    try cache.store.clear()
    #expect(FileManager.default.fileExists(atPath: second.path) == false)
  }

  @Test("clearing an empty cache is not an error")
  func clearingEmptyCacheSucceeds() throws {
    let cache = TemporaryExportCache()
    defer { cache.remove() }

    try cache.store.clear()
    try cache.store.clear()
  }

  @Test("exports live in the caches directory, not in Documents")
  func writesToCaches() throws {
    // The shipped store is asked where it would write rather than made to
    // write there: this is a claim about the path the app ships with, and the
    // real caches directory is shared by every test in the bundle.
    let directory = try #require(DensityExportStore().directory)
    let caches = try #require(
      FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    )

    #expect(directory.path.hasPrefix(caches.path))
    #expect(directory.path.contains("/Documents/") == false)
    #expect(directory.lastPathComponent == "DensityExports")
  }

  @Test("a store clears its own directory and no other")
  func storesDoNotClearEachOther() throws {
    let cache = TemporaryExportCache()
    defer { cache.remove() }
    let neighbour = TemporaryExportCache()
    defer { neighbour.remove() }

    let url = try cache.store.write(Data("{}".utf8), named: "pathnod-density-scoped.json")
    #expect(url.path.hasPrefix(cache.container.path))

    _ = try neighbour.store.write(Data("{}".utf8), named: "pathnod-density-neighbour.json")
    try neighbour.store.clear()

    #expect(FileManager.default.fileExists(atPath: url.path))
  }
}

@MainActor
@Suite("Scan controller")
struct BLEScanControllerTests {
  private final class CentralDouble: CentralScanning {
    var currentState: CBManagerState = .unknown
    private(set) var isScanning = false
    private(set) var startCount = 0
    private(set) var stopCount = 0

    func startGenericScan() {
      isScanning = true
      startCount += 1
    }

    func stopScanning() {
      isScanning = false
      stopCount += 1
    }
  }

  /// Every controller clears its export cache as it is created, so each test
  /// gets a controller pointed at a directory of its own. See
  /// ``TemporaryExportCache``.
  private func makeController() -> (controller: BLEScanController, cache: TemporaryExportCache) {
    let cache = TemporaryExportCache()
    return (BLEScanController(store: cache.store), cache)
  }

  private func makeController(
    central: CentralDouble,
    advertiserLimit: Int = SessionAccumulator.defaultAdvertiserLimit
  ) -> (controller: BLEScanController, cache: TemporaryExportCache) {
    let cache = TemporaryExportCache()
    return (
      BLEScanController(
        store: cache.store,
        advertiserLimit: advertiserLimit,
        makeCentral: { _ in central }
      ),
      cache
    )
  }

  @Test("a fresh controller is idle, undisclosed and scanning nothing")
  func startsIdle() {
    let (controller, cache) = makeController()
    defer { cache.remove() }

    #expect(controller.summary.state == .idle)
    #expect(controller.hasAcknowledgedDisclosure == false)
    #expect(controller.canStart == false)
    #expect(controller.canStop == false)
    #expect(controller.canExport == false)
    #expect(controller.isAwaitingRadio == false)
    #expect(controller.exportURL == nil)
    #expect(controller.exportDocument == nil)
    #expect(controller.rulesetVersion == ClassificationRules.version)
    #expect(controller.rulesetFailure == nil)
  }

  @Test("the disclosure gate blocks Start until it is acknowledged")
  func disclosureGatesStart() {
    let (controller, cache) = makeController()
    defer { cache.remove() }

    controller.start()
    #expect(controller.summary.state == .idle)
    #expect(controller.isAwaitingRadio == false)

    controller.acknowledgeDisclosure()
    #expect(controller.canStart)
  }

  @Test("the committed disclosure states every limit of the study")
  func disclosureIsComplete() {
    let text = BLEScanController.disclosure.lowercased()

    #expect(text.contains("foreground"))
    #expect(text.contains("never connects"))
    #expect(text.contains("location"))
    #expect(text.contains("aggregate"))
  }

  @Test("a lifecycle change on an idle controller counts no interruption")
  func lifecycleOnIdleIsNotAnInterruption() {
    let (controller, cache) = makeController()
    defer { cache.remove() }

    controller.handleScenePhase(.background)
    controller.handleScenePhase(.inactive)
    controller.handleScenePhase(.active)

    #expect(controller.summary.interruptionCount == 0)
    #expect(controller.summary.state == .idle)
  }

  @Test("an unfinished session exports nothing")
  func exportRequiresAFinishedSession() {
    let (controller, cache) = makeController()
    defer { cache.remove() }

    controller.exportResult()

    #expect(controller.exportURL == nil)
    #expect(controller.exportDocument == nil)
    #expect(controller.exportFailure == nil)
  }

  @Test("the reported app version is never blank")
  func applicationVersionIsPresent() {
    let (controller, cache) = makeController()
    defer { cache.remove() }

    #expect(controller.applicationVersion.trimmingCharacters(in: .whitespaces).isEmpty == false)
  }

  @Test("a controller only ever clears the cache it was given")
  func controllerClearsOnlyItsOwnCache() throws {
    let neighbour = TemporaryExportCache()
    defer { neighbour.remove() }
    let survivor = try neighbour.store.write(
      Data("{}".utf8),
      named: "pathnod-density-neighbour.json"
    )

    // Creating a controller clears its cache on the spot, which is what used
    // to reach into a directory shared with every other test.
    let (controller, cache) = makeController()
    defer { cache.remove() }
    controller.discardResult()

    #expect(FileManager.default.fileExists(atPath: survivor.path))
    #expect(controller.exportFailure == nil)
  }

  @Test("unknown during scanning interrupts once and recovery requires Resume")
  func unknownDuringScanningRequiresResume() {
    let central = CentralDouble()
    let (controller, cache) = makeController(central: central)
    defer { cache.remove() }

    controller.acknowledgeDisclosure()
    controller.start()
    #expect(controller.isAwaitingRadio)
    #expect(controller.summary.state == .idle)

    central.currentState = .poweredOn
    controller.applyRadioState(.poweredOn)
    #expect(controller.summary.state == .scanning)
    #expect(central.startCount == 1)

    central.currentState = .unknown
    controller.applyRadioState(.unknown)
    controller.applyRadioState(.unknown)
    #expect(controller.summary.state == .interrupted)
    #expect(controller.summary.interruptionCount == 1)
    #expect(central.stopCount == 1)

    central.currentState = .poweredOn
    controller.applyRadioState(.poweredOn)
    #expect(controller.summary.state == .interrupted)
    #expect(central.startCount == 1)
    #expect(controller.canResume)

    controller.resume()
    #expect(controller.summary.state == .scanning)
    #expect(central.startCount == 2)
  }

  @Test("the truncation warning persists through pause and finish, then clears on delete")
  func advertiserLimitWarningLifecycle() throws {
    let central = CentralDouble()
    central.currentState = .poweredOn
    let (controller, cache) = makeController(central: central, advertiserLimit: 1)
    defer { cache.remove() }

    controller.acknowledgeDisclosure()
    controller.start()
    controller.record(peripheralID: UUID(), advertisementData: [:])
    #expect(AdvertiserLimitWarning(summary: controller.summary) == nil)

    controller.record(peripheralID: UUID(), advertisementData: [:])
    controller.refresh()
    let scanningWarning = try #require(AdvertiserLimitWarning(summary: controller.summary))

    controller.pause()
    #expect(AdvertiserLimitWarning(summary: controller.summary) == scanningWarning)

    controller.stop()
    #expect(AdvertiserLimitWarning(summary: controller.summary) == scanningWarning)

    controller.discardResult()
    #expect(AdvertiserLimitWarning(summary: controller.summary) == nil)
  }
}

@Suite("Bundle configuration")
struct BundleConfigurationTests {
  /// The exact text DEV-08 specifies. Reformatting it is a change to what the
  /// user is told, so the suite compares it character for character.
  static let expectedBluetoothUsageDescription =
    "Pathnod uses Bluetooth to count nearby BLE advertisers during a foreground density study. It does not connect to devices or export identifiers."

  @Test("the Bluetooth permission string is the committed text")
  func bluetoothUsageDescription() throws {
    let info = try #require(Bundle.main.infoDictionary)
    let description = try #require(info["NSBluetoothAlwaysUsageDescription"] as? String)

    #expect(description == Self.expectedBluetoothUsageDescription)
  }

  @Test(
    "no background mode, location permission or live activity is declared",
    arguments: [
      "UIBackgroundModes",
      "NSLocationWhenInUseUsageDescription",
      "NSLocationAlwaysAndWhenInUseUsageDescription",
      "NSLocationAlwaysUsageDescription",
      "NSLocationTemporaryUsageDescriptionDictionary",
      "NSLocalNetworkUsageDescription",
      "NSBluetoothPeripheralUsageDescription",
      "NSSupportsLiveActivities",
      "NSUserTrackingUsageDescription",
    ])
  func noForbiddenCapabilities(_ key: String) throws {
    let info = try #require(Bundle.main.infoDictionary)

    #expect(info.keys.contains(key) == false, "Info.plist must not declare \(key)")
  }
}
