import Foundation
import PathnodObserverEnrollment

/// Explicit test input: the device signatures stay genuine while reported RTT is increased.
public enum ObservationLatencySimulation {
    public static let addedDelayMilliseconds: UInt16 = 600

    public static func transcript(capture: ObservationCapture, credential: ObserverCredential,
                                  enrollment: ObserverMerklePath) throws -> ObservationTranscript {
        var transcript = try ObservationTranscript(capture: capture, credential: credential, enrollment: enrollment)
        for index in transcript.challenges.indices {
            let (delayed, overflow) = transcript.challenges[index].roundTripMilliseconds
                .addingReportingOverflow(addedDelayMilliseconds)
            guard !overflow else { throw ObservationTranscriptError.invalidTranscript }
            transcript.challenges[index].roundTripMilliseconds = delayed
        }
        try transcript.validate()
        return transcript
    }
}
