import Foundation
import PathnodDensityCore
import Testing

// What a session concludes about one peripheral when several rules contend for
// it, and the evidence arrives spread over separate advertisements.
//
// The property under test throughout is that a verdict follows the evidence and
// not the way the radio happened to package it: the same signatures, seen in one
// advertisement or in several, in either order, must produce the same category,
// the same rule rows and the same totals.

@Suite("Contended evidence")
struct ContendedEvidenceTests {
  private func session() throws -> SessionAccumulator {
    let accumulator = SessionAccumulator(
      classifier: AdvertisementClassifier(registry: try contendedRegistry()),
      clock: TestDensityClock(),
      makeSessionID: { fixedSessionID() }
    )
    accumulator.start()
    return accumulator
  }

  private func ad(_ services: String...) throws -> AdvertisementSnapshot {
    advertisement(services: try services.map { try serviceUUID($0) })
  }

  /// Shows one peripheral a sequence of advertisements and returns what the
  /// session knows afterwards.
  private func seeing(_ advertisements: [AdvertisementSnapshot]) throws -> SessionSummary {
    let accumulator = try session()
    let peripheral = PeripheralKey(UUID())
    for snapshot in advertisements {
      accumulator.recordChecked(peripheral, snapshot)
    }
    return accumulator.summary
  }

  private func expectContended(_ summary: SessionSummary, _ comment: Comment) {
    #expect(summary.uniqueAdvertisers == 1, comment)
    #expect(summary.counts[.unknown] == 1, comment)
    #expect(summary.counts[.helium] == 0, comment)
    #expect(summary.counts[.wifi] == 0, comment)
    #expect(summary.counts[.ev] == 0, comment)
    #expect(summary.byRule.isEmpty, comment)
  }

  @Test("two categories tying at one priority contend, however the sightings are grouped")
  func contendingCategoriesDoNotDependOnGrouping() throws {
    let helium = TestUUIDs.contendedHeliumHigh
    let wifi = TestUUIDs.contendedWifiHigh

    expectContended(try seeing([try ad(helium, wifi)]), "one advertisement carrying both")
    expectContended(try seeing([try ad(helium), try ad(wifi)]), "helium first")
    expectContended(try seeing([try ad(wifi), try ad(helium)]), "wifi first")
  }

  @Test("neither confidence nor the rule identifier separates two categories")
  func tieBreaksDoNotCrossCategories() throws {
    // `b-wifi-high` sorts before every helium rule and is just as confident, so
    // a tie-break leaking across categories would hand it the peripheral.
    let summary = try seeing([try ad(TestUUIDs.contendedWifiHigh, TestUUIDs.contendedHeliumMedium)])

    expectContended(summary, "a smaller identifier is not evidence about a category")
  }

  @Test("lower-priority evidence never settles a contended peripheral")
  func lowerPriorityDoesNotSettleAContest() throws {
    let contested = [try ad(TestUUIDs.contendedHeliumHigh, TestUUIDs.contendedWifiHigh)]
    let weak = try ad(TestUUIDs.contendedEVLow)

    expectContended(try seeing(contested + [weak]), "the weak match arrived second")
    expectContended(try seeing([weak] + contested), "the weak match arrived first")
  }

  @Test("evidence of equal priority never settles a contended peripheral")
  func equalPriorityDoesNotSettleAContest() throws {
    let contested = [try ad(TestUUIDs.contendedHeliumHigh, TestUUIDs.contendedWifiHigh)]

    expectContended(
      try seeing(contested + [try ad(TestUUIDs.contendedHeliumHigh)]),
      "one of the contending rules, seen again on its own"
    )
    expectContended(
      try seeing(contested + [try ad(TestUUIDs.contendedHeliumMedium)]),
      "another rule of a contending category, at the same priority"
    )
    expectContended(
      try seeing([try ad(TestUUIDs.contendedHeliumMedium)] + contested),
      "the same evidence, in the other order"
    )
  }

  @Test("only genuinely higher priority settles a contended peripheral")
  func higherPriorityResolvesAContest() throws {
    let contested = [try ad(TestUUIDs.contendedHeliumHigh, TestUUIDs.contendedWifiHigh)]
    let strong = try ad(TestUUIDs.contendedEVAbove)

    for (summary, order) in [
      (try seeing(contested + [strong]), "the strong match arrived second" as Comment),
      (try seeing([strong] + contested), "the strong match arrived first"),
    ] {
      #expect(summary.uniqueAdvertisers == 1, order)
      #expect(summary.counts[.ev] == 1, order)
      #expect(summary.counts[.unknown] == 0, order)
      #expect(summary.byRule.map(\.ruleID) == ["a-ev-above"], order)
      #expect(summary.byRule.map(\.count) == [1], order)
    }
  }

  @Test("confidence separates two rules of one category, in either order")
  func confidenceSeparatesOneCategory() throws {
    let high = try ad(TestUUIDs.contendedHeliumHigh)
    let medium = try ad(TestUUIDs.contendedHeliumMedium)

    for (summary, order) in [
      (try seeing([medium, high]), "the confident rule arrived second" as Comment),
      (try seeing([high, medium]), "the confident rule arrived first"),
      (
        try seeing([
          advertisement(services: [
            try serviceUUID(TestUUIDs.contendedHeliumHigh),
            try serviceUUID(TestUUIDs.contendedHeliumMedium),
          ])
        ]), "both in one advertisement"
      ),
    ] {
      #expect(summary.counts[.helium] == 1, order)
      #expect(summary.byRule.map(\.ruleID) == ["c-helium-high"], order)
    }
  }

  @Test("the smaller identifier separates two equally confident rules of one category")
  func identifierSeparatesOneCategory() throws {
    let first = try ad(TestUUIDs.contendedHeliumHigh)
    let second = try ad(TestUUIDs.contendedHeliumHighAlternate)

    for (summary, order) in [
      (try seeing([first, second]), "c-helium-high first" as Comment),
      (try seeing([second, first]), "f-helium-high first"),
    ] {
      #expect(summary.counts[.helium] == 1, order)
      #expect(summary.byRule.map(\.ruleID) == ["c-helium-high"], order)
    }
  }

  @Test("a repeated sighting of evidence already held changes nothing")
  func repeatedEvidenceIsIdempotent() throws {
    let contested = try ad(TestUUIDs.contendedHeliumHigh, TestUUIDs.contendedWifiHigh)

    expectContended(
      try seeing([contested, contested, contested]), "the same conflict, three times")

    let settled = try seeing([try ad(TestUUIDs.contendedEVLow), try ad(TestUUIDs.contendedEVLow)])
    #expect(settled.counts[.ev] == 1)
    #expect(settled.byRule.map(\.count) == [1])
  }

  @Test("counts and rule rows reconcile while evidence moves, and the export follows")
  func totalsReconcileAsEvidenceMoves() throws {
    let accumulator = try session()
    let contended = PeripheralKey(UUID())
    let promoted = PeripheralKey(UUID())
    let plain = PeripheralKey(UUID())

    // One peripheral loses a clean match to a contest it cannot settle.
    accumulator.recordChecked(contended, try ad(TestUUIDs.contendedHeliumHigh))
    #expect(accumulator.summary.counts[.helium] == 1)
    #expect(accumulator.summary.byRule.map(\.ruleID) == ["c-helium-high"])
    accumulator.recordChecked(contended, try ad(TestUUIDs.contendedWifiHigh))
    #expect(accumulator.summary.counts[.helium] == 0)
    #expect(accumulator.summary.byRule.isEmpty)

    // Another goes through the same contest and is then settled from above.
    accumulator.recordChecked(promoted, try ad(TestUUIDs.contendedHeliumHigh))
    accumulator.recordChecked(promoted, try ad(TestUUIDs.contendedWifiHigh))
    accumulator.recordChecked(promoted, try ad(TestUUIDs.contendedEVAbove))

    // A third is never contested at all.
    accumulator.recordChecked(plain, try ad(TestUUIDs.contendedEVLow))

    let summary = accumulator.summary
    #expect(summary.uniqueAdvertisers == 3)
    #expect(summary.counts[.unknown] == 1)
    #expect(summary.counts[.ev] == 2)
    #expect(summary.counts[.helium] == 0)
    #expect(summary.counts[.wifi] == 0)
    #expect(summary.classifiedTotal == summary.uniqueAdvertisers)
    #expect(summary.byRule.map(\.ruleID) == ["a-ev-above", "e-ev-low"])
    #expect(summary.byRule.map(\.count) == [1, 1])

    accumulator.finish()
    let document = try DensityExport.makeDocument(
      from: accumulator.summary,
      appVersion: "0.1.0"
    )

    #expect(document.counts == DensityExportCounts(helium: 0, wifi: 0, ev: 2, unknown: 1))
    #expect(document.counts.total == document.uniqueAdvertisers)
    #expect(document.byRule.reduce(0) { $0 + $1.count } == document.counts.classifiedTotal)
  }
}
