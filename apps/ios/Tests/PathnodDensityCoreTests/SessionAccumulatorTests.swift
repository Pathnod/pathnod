import Foundation
import PathnodDensityCore
import Testing

@Suite("Session accumulation")
struct SessionAccumulatorTests {
  private func makeAccumulator(
    registry: ClassificationRegistry? = nil,
    clock: TestDensityClock = TestDensityClock()
  ) throws -> SessionAccumulator {
    SessionAccumulator(
      classifier: AdvertisementClassifier(registry: try registry ?? referenceRegistry()),
      clock: clock,
      makeSessionID: { fixedSessionID() }
    )
  }

  @Test("a fresh accumulator is idle and empty")
  func startsIdle() throws {
    let accumulator = try makeAccumulator()
    let summary = accumulator.summary

    #expect(summary.state == .idle)
    #expect(summary.startedAt == nil)
    #expect(summary.endedAt == nil)
    #expect(summary.uniqueAdvertisers == 0)
    #expect(summary.wallClockSeconds == 0)
    #expect(summary.foregroundScanSeconds == 0)
    #expect(summary.interruptionCount == 0)
    #expect(summary.byRule.isEmpty)
    #expect(summary.counts == [.helium: 0, .wifi: 0, .ev: 0, .unknown: 0])
  }

  @Test("sightings before Start are ignored")
  func ignoresSightingsBeforeStart() throws {
    let accumulator = try makeAccumulator()

    let outcome = accumulator.record(
      peripheral: PeripheralKey(UUID()),
      advertisement: advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    )

    #expect(outcome == nil)
    #expect(accumulator.uniqueAdvertisers == 0)
  }

  @Test("repeated sightings of one peripheral count once")
  func repeatedSightingsCountOnce() throws {
    let accumulator = try makeAccumulator()
    accumulator.start()

    let peripheral = PeripheralKey(UUID())
    let snapshot = advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])

    for _ in 0..<25 {
      accumulator.recordChecked(peripheral, snapshot)
    }

    let summary = accumulator.summary
    #expect(summary.uniqueAdvertisers == 1)
    #expect(summary.counts[.helium] == 1)
    #expect(summary.byRule.count == 1)
    #expect(summary.byRule.first?.count == 1)
  }

  @Test("two identifiers carrying identical advertisements count twice")
  func identicalAdvertisementsFromTwoIdentifiersCountTwice() throws {
    let accumulator = try makeAccumulator()
    accumulator.start()

    let snapshot = advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    accumulator.recordChecked(PeripheralKey(UUID()), snapshot)
    accumulator.recordChecked(PeripheralKey(UUID()), snapshot)

    let summary = accumulator.summary
    #expect(summary.uniqueAdvertisers == 2)
    #expect(summary.counts[.helium] == 2)
    #expect(summary.byRule.first?.count == 2)
  }

  @Test("an advertisement carrying only a local name is counted as unknown")
  func localNameOnlyIsUnknown() throws {
    let accumulator = try makeAccumulator()
    accumulator.start()

    accumulator.recordChecked(PeripheralKey(UUID()), advertisement(carriesLocalName: true))

    let summary = accumulator.summary
    #expect(summary.uniqueAdvertisers == 1)
    #expect(summary.counts[.unknown] == 1)
    #expect(summary.byRule.isEmpty)
  }

  @Test("an empty ruleset counts every advertiser as unknown")
  func emptyRulesetCountsEverythingUnknown() throws {
    let accumulator = try makeAccumulator(
      registry: ClassificationRegistry.empty(version: "empty-1"))
    accumulator.start()

    accumulator.recordChecked(
      PeripheralKey(UUID()),
      advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    )
    accumulator.recordChecked(
      PeripheralKey(UUID()),
      advertisement(
        manufacturer: ManufacturerData(companyIdentifier: 0x004C, payload: [0x10, 0x20]))
    )

    let summary = accumulator.summary
    #expect(summary.rulesetVersion == "empty-1")
    #expect(summary.uniqueAdvertisers == 2)
    #expect(summary.counts[.unknown] == 2)
    #expect(summary.byRule.isEmpty)
  }

  @Test("a stronger later advertisement reclassifies the same peripheral")
  func strongerLaterAdvertisementReclassifies() throws {
    let accumulator = try makeAccumulator()
    accumulator.start()

    let peripheral = PeripheralKey(UUID())

    // Seen first with nothing a rule recognises.
    accumulator.recordChecked(peripheral, advertisement(carriesLocalName: true))
    #expect(accumulator.summary.counts[.unknown] == 1)

    // Then with the low-priority Wi-Fi manufacturer signature.
    accumulator.recordChecked(
      peripheral,
      advertisement(
        manufacturer: ManufacturerData(companyIdentifier: 0x004C, payload: [0x10, 0x20]))
    )
    #expect(accumulator.summary.counts[.wifi] == 1)
    #expect(accumulator.summary.counts[.unknown] == 0)

    // Finally with the high-priority Helium service UUID.
    accumulator.recordChecked(
      peripheral,
      advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    )

    let summary = accumulator.summary
    #expect(summary.uniqueAdvertisers == 1)
    #expect(summary.counts[.helium] == 1)
    #expect(summary.counts[.wifi] == 0)
    #expect(summary.counts[.unknown] == 0)
    #expect(summary.byRule.map(\.ruleID) == ["helium-service"])
    #expect(summary.byRule.first?.count == 1)
  }

  @Test("a weaker later advertisement never downgrades a peripheral")
  func weakerLaterAdvertisementIsIgnored() throws {
    let accumulator = try makeAccumulator()
    accumulator.start()

    let peripheral = PeripheralKey(UUID())
    accumulator.recordChecked(
      peripheral,
      advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    )
    accumulator.recordChecked(peripheral, advertisement(carriesLocalName: true))
    accumulator.recordChecked(
      peripheral,
      advertisement(
        manufacturer: ManufacturerData(companyIdentifier: 0x004C, payload: [0x10, 0x20]))
    )

    let summary = accumulator.summary
    #expect(summary.uniqueAdvertisers == 1)
    #expect(summary.counts[.helium] == 1)
    #expect(summary.byRule.map(\.ruleID) == ["helium-service"])
  }

  @Test("equal evidence resolves to the same rule regardless of advertisement order")
  func equalEvidenceIsOrderIndependent() throws {
    let firstService = try serviceUUID("F1E1")
    let secondService = try serviceUUID("F1E2")
    let registry = try ClassificationRegistry(
      version: "tie-1",
      rules: [
        rule(id: "a-rule", category: .helium, serviceUUIDs: [firstService], priority: 50),
        rule(id: "b-rule", category: .helium, serviceUUIDs: [secondService], priority: 50),
      ]
    )

    func winner(_ snapshots: [AdvertisementSnapshot]) throws -> String? {
      let accumulator = try makeAccumulator(registry: registry)
      let peripheral = PeripheralKey(UUID())
      accumulator.start()
      for snapshot in snapshots {
        accumulator.recordChecked(peripheral, snapshot)
      }
      return accumulator.summary.byRule.first?.ruleID
    }

    let a = advertisement(services: [firstService])
    let b = advertisement(services: [secondService])
    #expect(try winner([a, b]) == "a-rule")
    #expect(try winner([b, a]) == "a-rule")
  }

  @Test("an ambiguous later advertisement does not displace a clean match")
  func ambiguityDoesNotDisplaceAMatch() throws {
    let service = try serviceUUID(TestUUIDs.heliumService)
    let registry = try ClassificationRegistry(
      version: "conflict-1",
      rules: [
        rule(id: "a-helium", category: .helium, serviceUUIDs: [service], priority: 50),
        rule(
          id: "b-ev",
          category: .ev,
          manufacturerSignature: ManufacturerSignature(
            companyIdentifier: 0x00E0,
            dataPrefix: [0xAA]
          ),
          priority: 50
        ),
      ]
    )
    let accumulator = try makeAccumulator(registry: registry)
    accumulator.start()

    let peripheral = PeripheralKey(UUID())
    accumulator.recordChecked(peripheral, advertisement(services: [service]))
    accumulator.recordChecked(
      peripheral,
      advertisement(
        services: [service],
        manufacturer: ManufacturerData(companyIdentifier: 0x00E0, payload: [0xAA])
      )
    )

    let summary = accumulator.summary
    #expect(summary.uniqueAdvertisers == 1)
    #expect(summary.counts[.helium] == 1)
    #expect(summary.counts[.unknown] == 0)
  }

  @Test("a conflicting advertisement on a fresh peripheral is counted as unknown")
  func ambiguousFirstSightingIsUnknown() throws {
    let service = try serviceUUID(TestUUIDs.heliumService)
    let registry = try ClassificationRegistry(
      version: "conflict-1",
      rules: [
        rule(id: "a-helium", category: .helium, serviceUUIDs: [service], priority: 50),
        rule(
          id: "b-ev",
          category: .ev,
          manufacturerSignature: ManufacturerSignature(
            companyIdentifier: 0x00E0,
            dataPrefix: [0xAA]
          ),
          priority: 50
        ),
      ]
    )
    let accumulator = try makeAccumulator(registry: registry)
    accumulator.start()

    let outcome = accumulator.recordChecked(
      PeripheralKey(UUID()),
      advertisement(
        services: [service],
        manufacturer: ManufacturerData(companyIdentifier: 0x00E0, payload: [0xAA])
      )
    )

    #expect(outcome?.reason == .ambiguousMatch)

    let summary = accumulator.summary
    #expect(summary.uniqueAdvertisers == 1)
    #expect(summary.counts[.unknown] == 1)
    #expect(summary.byRule.isEmpty)
  }

  @Test("counters reconcile across a mixed population")
  func countersReconcile() throws {
    let accumulator = try makeAccumulator()
    accumulator.start()

    let helium = advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    let ev = advertisement(services: [try serviceUUID(TestUUIDs.evService)])
    let wifi = advertisement(
      manufacturer: ManufacturerData(companyIdentifier: 0x004C, payload: [0x10, 0x20])
    )
    let unknown = advertisement(
      services: [try serviceUUID(TestUUIDs.unrelatedService)],
      carriesLocalName: true
    )

    for snapshot in [helium, helium, ev, wifi, wifi, wifi, unknown] {
      accumulator.recordChecked(PeripheralKey(UUID()), snapshot)
    }

    let summary = accumulator.summary
    #expect(summary.uniqueAdvertisers == 7)
    #expect(summary.counts[.helium] == 2)
    #expect(summary.counts[.ev] == 1)
    #expect(summary.counts[.wifi] == 3)
    #expect(summary.counts[.unknown] == 1)
    #expect(summary.classifiedTotal == summary.uniqueAdvertisers)

    // Zero rows never appear, and rule rows are sorted by identifier.
    #expect(summary.byRule.map(\.ruleID) == ["ev-service", "helium-service", "wifi-manufacturer"])
    #expect(summary.byRule.map(\.count) == [1, 2, 3])
    #expect(summary.byRule.allSatisfy { $0.count > 0 })
  }

  @Test("rule rows carry the provenance the registry declared")
  func ruleRowsCarryProvenance() throws {
    let accumulator = try makeAccumulator()
    accumulator.start()
    accumulator.recordChecked(
      PeripheralKey(UUID()),
      advertisement(services: [try serviceUUID(TestUUIDs.evService)])
    )

    let row = try #require(accumulator.summary.byRule.first)
    #expect(row.ruleID == "ev-service")
    #expect(row.category == .ev)
    #expect(row.confidence == .medium)
    #expect(row.sourceKind == .partnerConfirmed)
    #expect(row.sourceReference == "fixture: EV service UUID")
  }

  @Test("foreground time excludes an interruption, wall clock does not")
  func pauseAndResumeTiming() throws {
    let clock = TestDensityClock()
    let accumulator = try makeAccumulator(clock: clock)

    accumulator.start()
    clock.advance(by: 60)

    accumulator.interrupt()
    #expect(accumulator.state == .interrupted)
    clock.advance(by: 300)

    // Nothing is counted while interrupted.
    let ignored = accumulator.record(
      peripheral: PeripheralKey(UUID()),
      advertisement: advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    )
    #expect(ignored == nil)
    #expect(accumulator.summary.foregroundScanSeconds == 60)

    accumulator.resume()
    clock.advance(by: 40)
    accumulator.finish()

    let summary = accumulator.summary
    #expect(summary.state == .finished)
    #expect(summary.interruptionCount == 1)
    #expect(summary.foregroundScanSeconds == 100)
    #expect(summary.wallClockSeconds == 400)

    // A finished session stops advancing.
    clock.advance(by: 1_000)
    #expect(accumulator.summary.wallClockSeconds == 400)
    #expect(accumulator.summary.foregroundScanSeconds == 100)
  }

  @Test("resuming preserves the aggregates collected before the interruption")
  func resumePreservesAggregates() throws {
    let clock = TestDensityClock()
    let accumulator = try makeAccumulator(clock: clock)
    accumulator.start()

    let before = PeripheralKey(UUID())
    accumulator.recordChecked(
      before,
      advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    )

    clock.advance(by: 30)
    accumulator.interrupt()
    clock.advance(by: 30)
    accumulator.resume()

    accumulator.recordChecked(
      PeripheralKey(UUID()),
      advertisement(services: [try serviceUUID(TestUUIDs.evService)])
    )
    // The peripheral seen before the interruption is still deduplicated.
    accumulator.recordChecked(
      before,
      advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    )

    let summary = accumulator.summary
    #expect(summary.uniqueAdvertisers == 2)
    #expect(summary.counts[.helium] == 1)
    #expect(summary.counts[.ev] == 1)
    #expect(summary.interruptionCount == 1)
  }

  @Test("repeated lifecycle callbacks cannot inflate the interruption count")
  func repeatedInterruptionsCountOnce() throws {
    let accumulator = try makeAccumulator()
    accumulator.start()

    accumulator.interrupt()
    accumulator.interrupt()
    accumulator.interrupt()

    #expect(accumulator.summary.interruptionCount == 1)
    #expect(accumulator.state == .interrupted)
  }

  @Test("an interruption before Start is not counted")
  func interruptionWhileIdleIsIgnored() throws {
    let accumulator = try makeAccumulator()

    accumulator.interrupt()

    #expect(accumulator.state == .idle)
    #expect(accumulator.summary.interruptionCount == 0)
  }

  @Test("resume only leaves the interrupted state")
  func resumeRequiresInterruption() throws {
    let accumulator = try makeAccumulator()

    accumulator.resume()
    #expect(accumulator.state == .idle)

    accumulator.start()
    accumulator.resume()
    #expect(accumulator.state == .scanning)
  }

  @Test("Start is ignored while a scan is already running")
  func startIsIdempotentWhileScanning() throws {
    let clock = TestDensityClock()
    let accumulator = try makeAccumulator(clock: clock)

    accumulator.start()
    let sessionID = accumulator.sessionID
    clock.advance(by: 45)
    accumulator.recordChecked(
      PeripheralKey(UUID()),
      advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    )

    accumulator.start()

    #expect(accumulator.sessionID == sessionID)
    #expect(accumulator.summary.wallClockSeconds == 45)
    #expect(accumulator.uniqueAdvertisers == 1)
  }

  @Test("a finished session counts nothing more")
  func finishedSessionIsClosed() throws {
    let accumulator = try makeAccumulator()
    accumulator.start()
    accumulator.recordChecked(
      PeripheralKey(UUID()),
      advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    )
    accumulator.finish()

    let ignored = accumulator.record(
      peripheral: PeripheralKey(UUID()),
      advertisement: advertisement(services: [try serviceUUID(TestUUIDs.evService)])
    )

    #expect(ignored == nil)
    #expect(accumulator.summary.uniqueAdvertisers == 1)

    // Finishing twice does not move the end timestamp or the state.
    let endedAt = accumulator.summary.endedAt
    accumulator.finish()
    #expect(accumulator.summary.endedAt == endedAt)
    #expect(accumulator.state == .finished)
  }

  @Test("finishing an interrupted session keeps the interruption count")
  func canFinishFromInterrupted() throws {
    let clock = TestDensityClock()
    let accumulator = try makeAccumulator(clock: clock)
    accumulator.start()
    clock.advance(by: 20)
    accumulator.interrupt()
    clock.advance(by: 20)
    accumulator.finish()

    let summary = accumulator.summary
    #expect(summary.state == .finished)
    #expect(summary.interruptionCount == 1)
    #expect(summary.foregroundScanSeconds == 20)
    #expect(summary.wallClockSeconds == 40)
  }

  @Test("reset clears every sighting, timer, counter and identifier")
  func resetClearsEverything() throws {
    let clock = TestDensityClock()
    var identifiers = [fixedSessionID("000000000001"), fixedSessionID("000000000002")]
    let accumulator = SessionAccumulator(
      classifier: AdvertisementClassifier(registry: try referenceRegistry()),
      clock: clock,
      makeSessionID: { identifiers.isEmpty ? UUID() : identifiers.removeFirst() }
    )

    accumulator.start()
    clock.advance(by: 120)
    accumulator.recordChecked(
      PeripheralKey(UUID()),
      advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    )
    accumulator.interrupt()
    accumulator.finish()

    let finishedID = accumulator.sessionID
    accumulator.reset()

    let summary = accumulator.summary
    #expect(summary.state == .idle)
    #expect(summary.sessionID != finishedID)
    #expect(summary.uniqueAdvertisers == 0)
    #expect(summary.counts == [.helium: 0, .wifi: 0, .ev: 0, .unknown: 0])
    #expect(summary.byRule.isEmpty)
    #expect(summary.interruptionCount == 0)
    #expect(summary.wallClockSeconds == 0)
    #expect(summary.foregroundScanSeconds == 0)
    #expect(summary.startedAt == nil)
    #expect(summary.endedAt == nil)
  }

  @Test("a peripheral seen before reset is a new advertiser afterwards")
  func resetForgetsDeduplication() throws {
    let accumulator = try makeAccumulator()
    let peripheral = PeripheralKey(UUID())
    let snapshot = advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])

    accumulator.start()
    accumulator.recordChecked(peripheral, snapshot)
    accumulator.finish()
    accumulator.reset()
    accumulator.start()
    accumulator.recordChecked(peripheral, snapshot)

    #expect(accumulator.summary.uniqueAdvertisers == 1)
    #expect(accumulator.summary.counts[.helium] == 1)
  }

  @Test("a peripheral key never reveals the identifier it wraps")
  func peripheralKeyIsRedacted() {
    let identifier = UUID()
    let key = PeripheralKey(identifier)

    #expect(key.description == "PeripheralKey(redacted)")
    #expect(key.debugDescription == "PeripheralKey(redacted)")
    #expect(String(describing: key).contains(identifier.uuidString) == false)
    #expect("\(key)".localizedCaseInsensitiveContains(identifier.uuidString) == false)
    #expect(PeripheralKey(identifier) == key)
  }
}
