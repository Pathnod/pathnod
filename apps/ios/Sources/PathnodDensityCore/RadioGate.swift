import Foundation

/// What the radio can do right now, as far as the system has told the app.
///
/// This is the app's own vocabulary, not CoreBluetooth's: the mapping from
/// `CBManagerState` lives in the app target, and everything below is decided
/// without a radio, a device or a framework. That is deliberate — the rules
/// that stop a session are the ones a simulator cannot rehearse, so they are
/// kept where they can be tested.
public enum RadioAvailability: String, Equatable, Sendable, CaseIterable {
  /// The system has not committed to a state. Every manager starts here, and
  /// stays here while iOS asks the user for Bluetooth permission. A state
  /// this build of the app has never heard of is reported here too: an app
  /// that cannot name a state cannot claim to be scanning under it.
  case unknown
  case unsupported
  case unauthorized
  case poweredOff
  case resetting
  case ready

  public var allowsScanning: Bool { self == .ready }
}

/// Decides what a change of radio availability means for the session in hand.
///
/// The one rule underneath all of it: the app never reports scanning it is not
/// doing. A session only runs while the radio says it is usable, so losing that
/// statement — including losing it to ``RadioAvailability/unknown``, which is
/// both the state before the first answer and the state CoreBluetooth falls
/// back to when it has none — interrupts the session. Recovery afterwards is
/// always an explicit Resume; nothing here ever resumes a session on its own.
public enum RadioGate {
  /// The single action the caller performs for a reported state.
  public enum Effect: Equatable, Sendable {
    /// The session is unaffected by the reported state.
    case hold
    /// A Start was waiting for a usable radio and can now begin.
    case beginSession
    /// Readiness was lost under a running scan: stop scanning, stop timing
    /// and count one interruption.
    case interrupt
  }

  public struct Decision: Equatable, Sendable {
    public let effect: Effect
    /// Whether a Start still waiting for its first usable radio state is
    /// dropped. A cancelled Start is not queued: the user has to tap again.
    public let cancelsPendingStart: Bool

    public init(effect: Effect, cancelsPendingStart: Bool) {
      self.effect = effect
      self.cancelsPendingStart = cancelsPendingStart
    }
  }

  /// - Parameters:
  ///   - availability: the state just reported.
  ///   - session: what the accumulator is doing.
  ///   - isAwaitingStart: whether a Start is waiting for a usable radio, which
  ///     is the window the permission prompt is answered in.
  public static func decide(
    availability: RadioAvailability,
    session: SessionState,
    isAwaitingStart: Bool
  ) -> Decision {
    guard availability.allowsScanning else {
      if session == .scanning {
        // The defining case: a scan that was running has lost the statement
        // it was running on. Which non-ready state replaced it does not
        // matter, and neither does how many times the same one is reported —
        // only a session in `scanning` can be interrupted, so the count rises
        // once per interruption.
        return Decision(effect: .interrupt, cancelsPendingStart: true)
      }
      // No scan is running, so there is nothing to undo. The only question
      // left is whether a pending Start survives: `unknown` before the first
      // usable state is the app waiting for an answer it has been promised,
      // while every other state is an answer, and a negative one.
      return Decision(
        effect: .hold,
        cancelsPendingStart: availability != .unknown
      )
    }

    if isAwaitingStart, session == .idle {
      // Consumed by the caller as it starts the session, not cancelled.
      return Decision(effect: .beginSession, cancelsPendingStart: false)
    }

    // A ready callback while already scanning is only a repeated observation,
    // not a reason to issue another scan request. More importantly, a ready
    // callback after an interruption sees `session == .interrupted` and holds:
    // recovery never substitutes for the user's explicit Resume tap.
    return Decision(effect: .hold, cancelsPendingStart: false)
  }
}
