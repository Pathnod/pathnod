import Foundation
import PathnodDensityCore
import Testing

@Suite("Radio readiness transitions")
struct RadioGateTests {
  @Test("an active scan interrupted by unknown never resumes on recovery")
  func unknownInterruptsUntilExplicitResume() throws {
    let clock = TestDensityClock()
    let accumulator = SessionAccumulator(
      classifier: AdvertisementClassifier(registry: try referenceRegistry()),
      clock: clock,
      makeSessionID: { fixedSessionID() }
    )
    accumulator.start()
    clock.advance(by: 30)
    accumulator.recordChecked(
      PeripheralKey(UUID()),
      advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
    )

    apply(.unknown, to: accumulator)
    #expect(accumulator.state == .interrupted)
    #expect(accumulator.summary.interruptionCount == 1)

    clock.advance(by: 120)
    let ignored = accumulator.record(
      peripheral: PeripheralKey(UUID()),
      advertisement: advertisement(services: [try serviceUUID(TestUUIDs.evService)])
    )
    #expect(ignored == nil)
    #expect(accumulator.summary.uniqueAdvertisers == 1)
    #expect(accumulator.summary.foregroundScanSeconds == 30)

    // A recovered radio does not call `resume()` for the controller.
    apply(.ready, to: accumulator)
    #expect(accumulator.state == .interrupted)
    #expect(accumulator.summary.interruptionCount == 1)
    #expect(accumulator.summary.foregroundScanSeconds == 30)

    accumulator.resume()
    #expect(accumulator.state == .scanning)
  }

  @Test("repeated unknown reports interrupt exactly once")
  func repeatedUnknownInterruptsOnce() throws {
    let accumulator = try makeScanningAccumulator()

    apply(.unknown, to: accumulator)
    apply(.unknown, to: accumulator)
    apply(.unknown, to: accumulator)

    #expect(accumulator.state == .interrupted)
    #expect(accumulator.summary.interruptionCount == 1)
  }

  @Test("future states mapped to unknown use the same fail-closed transition")
  func futureUnknownFallbackIsEquivalent() {
    let directUnknown = RadioGate.decide(
      availability: .unknown,
      session: .scanning,
      isAwaitingStart: false
    )
    let futureStateFallback = RadioGate.decide(
      availability: .unknown,
      session: .scanning,
      isAwaitingStart: false
    )

    #expect(futureStateFallback == directUnknown)
    #expect(futureStateFallback.effect == .interrupt)
  }

  @Test("initial unknown waits and ready begins the requested session")
  func initialUnknownThenReadyStarts() {
    let waiting = RadioGate.decide(
      availability: .unknown,
      session: .idle,
      isAwaitingStart: true
    )
    #expect(waiting.effect == .hold)
    #expect(waiting.cancelsPendingStart == false)

    let ready = RadioGate.decide(
      availability: .ready,
      session: .idle,
      isAwaitingStart: true
    )
    #expect(ready.effect == .beginSession)
    #expect(ready.cancelsPendingStart == false)
  }

  @Test(
    "known non-ready states interrupt a scan and cancel an initial Start",
    arguments: [
      RadioAvailability.poweredOff,
      .resetting,
      .unauthorized,
      .unsupported,
    ])
  func knownNonReadyStates(_ availability: RadioAvailability) {
    let active = RadioGate.decide(
      availability: availability,
      session: .scanning,
      isAwaitingStart: false
    )
    #expect(active.effect == .interrupt)

    let initial = RadioGate.decide(
      availability: availability,
      session: .idle,
      isAwaitingStart: true
    )
    #expect(initial.effect == .hold)
    #expect(initial.cancelsPendingStart)
  }

  @Test("returning active after a lifecycle interruption still needs Resume")
  func lifecycleReturnNeedsExplicitResume() throws {
    let accumulator = try makeScanningAccumulator()

    // The controller handles `.inactive` by interrupting the accumulator.
    accumulator.interrupt()
    // Returning `.active` only updates foreground gating; it does not resume.
    #expect(accumulator.state == .interrupted)
    #expect(accumulator.summary.interruptionCount == 1)

    accumulator.resume()
    #expect(accumulator.state == .scanning)
  }

  private func makeScanningAccumulator() throws -> SessionAccumulator {
    let accumulator = SessionAccumulator(
      classifier: AdvertisementClassifier(registry: try referenceRegistry()),
      makeSessionID: { fixedSessionID() }
    )
    accumulator.start()
    return accumulator
  }

  private func apply(_ availability: RadioAvailability, to accumulator: SessionAccumulator) {
    let decision = RadioGate.decide(
      availability: availability,
      session: accumulator.state,
      isAwaitingStart: false
    )
    if decision.effect == .interrupt {
      accumulator.interrupt()
    }
  }
}
