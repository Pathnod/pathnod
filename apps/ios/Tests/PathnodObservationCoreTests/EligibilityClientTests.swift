import Foundation
import XCTest
@testable import PathnodObservationCore

private actor Replies {
    var requests: [URLRequest] = []
    let duration: String?
    let status: Int
    let body: String
    init(duration: String? = "60", status: Int = 200, body: String = "") {
        self.duration = duration; self.status = status
        self.body = body.isEmpty ? "{\"registered\":true,\"protocol_id\":\"0x\(String(repeating: "01", count: 32))\",\"open_slots\":3,\"reward\":\"0.05\",\"policy_version\":1}" : body
    }
    func send(_ request: URLRequest) -> (Data, HTTPURLResponse) {
        requests.append(request)
        let headers = duration.map { ["x-pathnod-epoch-seconds": $0] } ?? [:]
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!)
    }
}

final class EligibilityClientTests: XCTestCase {
    func testConnectionPreparationSendsNoObserverOrDeviceData() async throws {
        let replies = Replies()
        let client = try EligibilityClient(baseURL: URL(string: "https://example.org")!, transport: { await replies.send($0) })
        try await client.prepareConnection()
        let requests = await replies.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].url?.path, "/health")
        XCTAssertNil(requests[0].url?.query); XCTAssertNil(requests[0].httpBody)
    }
    func testUnknownDevicesAndUnpaidChoiceGateCollection() async throws {
        let protocolID = "0x" + String(repeating: "01", count: 32)
        for registered in [false, true] {
            let replies = Replies(body: "{\"registered\":\(registered),\"protocol_id\":\"\(protocolID)\",\"open_slots\":0,\"reward\":\"0\",\"policy_version\":1}")
            let client = try EligibilityClient(baseURL: URL(string: "https://example.org")!, transport: { await replies.send($0) })
            let result = try await client.resolve(deviceID: Data(repeating: 2, count: 32), timeMilliseconds: 2_520_000)
            XCTAssertThrowsError(try result.requireCollectionPermission(allowUnpaid: false))
            if registered { XCTAssertNoThrow(try result.requireCollectionPermission(allowUnpaid: true)) }
            else { XCTAssertThrowsError(try result.requireCollectionPermission(allowUnpaid: true)) }
        }
    }
    func testProtocolSpecificEpochIsResolvedBeforeUse() async throws {
        let replies = Replies()
        let client = try EligibilityClient(baseURL: URL(string: "https://example.org")!, transport: { await replies.send($0) })
        let result = try await client.resolve(deviceID: Data(repeating: 2, count: 32), timeMilliseconds: 2_520_000)
        XCTAssertEqual(result.epoch, 42); XCTAssertEqual(result.epochSeconds, 60)
        let requests = await replies.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.map { URLComponents(url: $0.url!, resolvingAgainstBaseURL: false)!.queryItems!.first!.value }, ["0", "42"])
        XCTAssertTrue(requests.allSatisfy { $0.httpBody == nil && !$0.url!.absoluteString.contains("secret") })
    }

    func testMissingPeriodInvalidPayloadAndServerFailuresAreRejected() async throws {
        for replies in [Replies(duration: nil), Replies(duration: "0"), Replies(status: 503), Replies(body: "{}"),
                        Replies(body: "{\"registered\":true,\"protocol_id\":\"bad\",\"open_slots\":3,\"reward\":\"0.05\",\"policy_version\":1}")] {
            let client = try EligibilityClient(baseURL: URL(string: "https://example.org")!, transport: { await replies.send($0) })
            do { _ = try await client.resolve(deviceID: Data(repeating: 2, count: 32), timeMilliseconds: 2_520_000); XCTFail("Invalid reply accepted") }
            catch { XCTAssertTrue(error is ObservationError) }
        }
    }

    func testCancelledResolveDoesNotReturnAUsableQuote() async throws {
        let client = try EligibilityClient(baseURL: URL(string: "https://example.org")!, transport: { request in
            try await Task.sleep(for: .seconds(1))
            return await Replies().send(request)
        })
        let task = Task { try await client.resolve(deviceID: Data(repeating: 2, count: 32), timeMilliseconds: 2_520_000) }
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled request returned") } catch { XCTAssertTrue(error is CancellationError) }
    }
}
