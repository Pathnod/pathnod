import Foundation
import XCTest
@testable import PathnodObservationCore

final class ObservationStatusTests: XCTestCase {
    func testFinalizedStatusBindsTheOriginalObservationAndPaymentAccounting() throws {
        var object: [String: Any] = ["network":"devnet","program":"5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd",
            "protocol_id":String(repeating:"1",count:64),"device_id":String(repeating:"2",count:64),"epoch":42,
            "transcript_hash":String(repeating:"3",count:64),"status":"finalized","on_chain":true,"paid":true,
            "independent_observers":1,"paid_slots_used":1,"observation_root":String(repeating:"4",count:64)]
        func validate() throws {
            let value = try JSONDecoder().decode(ObservationChainStatus.self,from:JSONSerialization.data(withJSONObject:object))
            try value.validate(hash:String(repeating:"3",count:64),protocolID:String(repeating:"1",count:64),deviceID:String(repeating:"2",count:64))
        }
        try validate()
        object["paid_slots_used"] = 0; XCTAssertThrowsError(try validate()); object["paid_slots_used"] = 1
        object["transcript_hash"] = String(repeating:"5",count:64); XCTAssertThrowsError(try validate()); object["transcript_hash"] = String(repeating:"3",count:64)
        object["on_chain"] = false; XCTAssertThrowsError(try validate())
    }
    func testPendingCannotPromisePaymentOrAttachAnUnprovenSignature() throws {
        var object: [String: Any] = ["network":"devnet","program":"5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd",
            "protocol_id":String(repeating:"1",count:64),"device_id":String(repeating:"2",count:64),"epoch":42,
            "transcript_hash":String(repeating:"3",count:64),"status":"submitted","on_chain":false]
        func validate() throws {
            let value = try JSONDecoder().decode(ObservationChainStatus.self,from:JSONSerialization.data(withJSONObject:object))
            try value.validate(hash:String(repeating:"3",count:64),protocolID:String(repeating:"1",count:64),deviceID:String(repeating:"2",count:64))
        }
        try validate(); object["paid"] = true; XCTAssertThrowsError(try validate()); object.removeValue(forKey:"paid")
        object["transaction_signature"] = String(repeating:"1",count:88); XCTAssertThrowsError(try validate())
    }
}
