import Foundation
import PathnodDensityCore
import Testing

// How a session behaves when the device's civil clock is corrected underneath
// it, which a phone does on its own whenever it syncs, changes time zone or is
// edited by hand.
//
// Every case here asserts the same two things: the measured durations follow
// the monotonic reading and nothing else, and the session that comes out of it
// is still an export a reader can reconcile.

@Suite("Session timing across clock discontinuities")
struct SessionTimingTests {
  private func accumulator(clock: any DensityClock) throws -> SessionAccumulator {
    SessionAccumulator(
      classifier: AdvertisementClassifier(registry: try referenceRegistry()),
      clock: clock,
      makeSessionID: { fixedSessionID() }
    )
  }

  /// Re-reads the two timestamps the way a reader of the file would.
  private func exportedSeconds(_ document: DensityExportV1) throws -> Int {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)

    let startedAt = try #require(formatter.date(from: document.startedAt))
    let endedAt = try #require(formatter.date(from: document.endedAt))
    return Int(endedAt.timeIntervalSince(startedAt))
  }

  /// Asserts what must be true of any export, whatever the clock did.
  private func expectReconcilable(_ document: DensityExportV1) throws {
    #expect(document.foregroundScanSeconds >= 0)
    #expect(document.foregroundScanSeconds <= document.wallClockSeconds)
    #expect(try exportedSeconds(document) == document.wallClockSeconds)
  }

  @Test("civil time running forward during a scan does not inflate it")
  func forwardJumpWhileScanning() throws {
    let clock = TestDensityClock()
    let accumulator = try accumulator(clock: clock)

    accumulator.start()
    let startedAt = try #require(accumulator.summary.startedAt)
    clock.advance(by: 60)
    clock.shiftCivilTime(by: 3_600)
    clock.advance(by: 30)
    accumulator.finish()

    let summary = accumulator.summary
    #expect(summary.startedAt == startedAt)
    #expect(summary.wallClockSeconds == 90)
    #expect(summary.foregroundScanSeconds == 90)
    #expect(summary.endedAt == startedAt.addingTimeInterval(90))

    try expectReconcilable(
      try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
    )
  }

  @Test("civil time running backwards during a scan does not shorten it")
  func backwardJumpWhileScanning() throws {
    let clock = TestDensityClock()
    let accumulator = try accumulator(clock: clock)

    accumulator.start()
    clock.advance(by: 60)
    clock.shiftCivilTime(by: -7_200)
    clock.advance(by: 30)
    accumulator.finish()

    let summary = accumulator.summary
    #expect(summary.wallClockSeconds == 90)
    #expect(summary.foregroundScanSeconds == 90)

    let document = try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
    #expect(document.startedAt == "2025-09-22T00:00:00Z")
    #expect(document.endedAt == "2025-09-22T00:01:30Z")
    try expectReconcilable(document)
  }

  @Test(
    "a civil-time correction while paused changes neither duration",
    arguments: [3_600.0, -3_600.0])
  func jumpWhilePaused(_ shift: TimeInterval) throws {
    let clock = TestDensityClock()
    let accumulator = try accumulator(clock: clock)

    accumulator.start()
    clock.advance(by: 60)
    accumulator.interrupt()
    clock.shiftCivilTime(by: shift)
    clock.advance(by: 120)
    accumulator.resume()
    clock.advance(by: 30)
    accumulator.finish()

    let summary = accumulator.summary
    #expect(summary.interruptionCount == 1)
    #expect(summary.wallClockSeconds == 210)
    #expect(summary.foregroundScanSeconds == 90)
    try expectReconcilable(
      try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
    )
  }

  @Test("a long interruption is wall-clock time and nothing else")
  func longInterruptionIsNotForegroundTime() throws {
    let clock = TestDensityClock()
    let accumulator = try accumulator(clock: clock)

    accumulator.start()
    clock.advance(by: 300)
    accumulator.interrupt()
    // Two hours in the app switcher, with the clock corrected twice on the way.
    clock.shiftCivilTime(by: -45)
    clock.advance(by: 7_200)
    clock.shiftCivilTime(by: 45)
    #expect(accumulator.summary.foregroundScanSeconds == 300)
    #expect(accumulator.summary.wallClockSeconds == 7_500)

    accumulator.resume()
    clock.advance(by: 300)
    accumulator.finish()

    let summary = accumulator.summary
    #expect(summary.wallClockSeconds == 7_800)
    #expect(summary.foregroundScanSeconds == 600)
    try expectReconcilable(
      try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
    )
  }

  @Test("fractional readings produce whole seconds that still reconcile")
  func fractionalReadingsReconcile() throws {
    let clock = TestDensityClock(Date(timeIntervalSince1970: 1_758_499_200.75))
    let accumulator = try accumulator(clock: clock)

    accumulator.start()
    clock.advance(by: 30.4)
    accumulator.interrupt()
    clock.advance(by: 10.2)
    accumulator.resume()
    clock.advance(by: 5.9)
    accumulator.finish()

    let summary = accumulator.summary
    // 46.5 seconds of session, 36.3 of them scanning, truncated to the
    // resolution the schema carries.
    #expect(summary.wallClockSeconds == 46)
    #expect(summary.foregroundScanSeconds == 36)
    // The civil anchor is floored, so the sub-second part cannot leak into the
    // difference between the two timestamps.
    #expect(summary.startedAt == Date(timeIntervalSince1970: 1_758_499_200))

    let document = try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
    #expect(document.startedAt == "2025-09-22T00:00:00Z")
    #expect(document.endedAt == "2025-09-22T00:00:46Z")
    try expectReconcilable(document)
  }

  @Test("a clock that only knows civil time can under-report but never inflate")
  func civilOnlyClockUnderReports() throws {
    // The device is corrected 90 seconds backwards while the session is paused,
    // which is all a clock like this one can tell the accumulator about.
    let clock = CivilOnlyClock()
    let accumulator = try accumulator(clock: clock)

    accumulator.start()
    clock.now = Date(timeIntervalSince1970: 1_100)
    accumulator.interrupt()
    clock.now = Date(timeIntervalSince1970: 1_010)
    accumulator.resume()
    clock.now = Date(timeIntervalSince1970: 1_020)
    accumulator.finish()

    let summary = accumulator.summary
    // The scan itself was measured correctly on both sides of the pause; the
    // pause is the segment the correction fell in, so it contributes nothing.
    #expect(summary.foregroundScanSeconds == 110)
    #expect(summary.wallClockSeconds == 110)
    #expect(summary.foregroundScanSeconds <= summary.wallClockSeconds)

    let document = try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
    #expect(document.startedAt == "1970-01-01T00:16:40Z")
    #expect(document.endedAt == "1970-01-01T00:18:30Z")
    try expectReconcilable(document)
  }

  @Test("a rollback during the scan itself is absorbed segment by segment")
  func civilOnlyClockRollbackWhileScanning() throws {
    let clock = CivilOnlyClock()
    let accumulator = try accumulator(clock: clock)

    accumulator.start()
    clock.now = Date(timeIntervalSince1970: 400)
    // Mid-segment, so the segment measures from its opening reading: nothing.
    #expect(accumulator.summary.wallClockSeconds == 0)
    #expect(accumulator.summary.foregroundScanSeconds == 0)

    clock.now = Date(timeIntervalSince1970: 1_050)
    accumulator.finish()

    let summary = accumulator.summary
    #expect(summary.wallClockSeconds == 50)
    #expect(summary.foregroundScanSeconds == 50)
    try expectReconcilable(
      try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
    )
  }

  @Test("a finished session ignores whatever the clock does next")
  func finishedSessionIgnoresLaterJumps() throws {
    let clock = TestDensityClock()
    let accumulator = try accumulator(clock: clock)

    accumulator.start()
    clock.advance(by: 120)
    accumulator.finish()
    let finished = accumulator.summary

    clock.advance(by: 5_000)
    clock.shiftCivilTime(by: -100_000)
    clock.advance(by: 5_000)

    #expect(accumulator.summary == finished)
    #expect(accumulator.summary.wallClockSeconds == 120)
    #expect(accumulator.summary.endedAt == finished.endedAt)
  }

  @Test("a session has no end until it is stopped")
  func unfinishedSessionsHaveNoEnd() throws {
    let clock = TestDensityClock()
    let accumulator = try accumulator(clock: clock)

    #expect(accumulator.summary.endedAt == nil)

    accumulator.start()
    clock.advance(by: 10)
    #expect(accumulator.summary.endedAt == nil)

    accumulator.interrupt()
    clock.shiftCivilTime(by: -50_000)
    clock.advance(by: 10)
    #expect(accumulator.summary.endedAt == nil)

    accumulator.finish()
    let summary = accumulator.summary
    let startedAt = try #require(summary.startedAt)
    #expect(summary.endedAt == startedAt.addingTimeInterval(20))
  }

  @Test("a reset session forgets every reading of the one before it")
  func resetForgetsTiming() throws {
    let clock = TestDensityClock()
    let accumulator = try accumulator(clock: clock)

    accumulator.start()
    clock.advance(by: 90)
    accumulator.finish()
    accumulator.reset()

    #expect(accumulator.summary.wallClockSeconds == 0)
    #expect(accumulator.summary.foregroundScanSeconds == 0)
    #expect(accumulator.summary.endedAt == nil)

    clock.shiftCivilTime(by: 3_600)
    accumulator.start()
    clock.advance(by: 15)
    accumulator.finish()

    let summary = accumulator.summary
    #expect(summary.wallClockSeconds == 15)
    #expect(summary.foregroundScanSeconds == 15)
    try expectReconcilable(
      try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
    )
  }
}
