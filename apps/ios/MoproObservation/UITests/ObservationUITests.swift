import XCTest

final class ObservationUITests: XCTestCase {
    func testProofOnDevice() {
        let app = XCUIApplication()
        app.launch()
        app.buttons["proveObservation"].tap()

        let status = app.staticTexts["proofStatus"]
        let completed = NSPredicate(format: "label == %@", "Proof generated and verified.")
        expectation(for: completed, evaluatedWith: status)
        waitForExpectations(timeout: 120)

        XCTAssertEqual(status.label, "Proof generated and verified.")
        let seconds = app.staticTexts["proofSeconds"].label
        let memory = app.staticTexts["peakMemoryMB"].label
        XCTContext.runActivity(named: "Proof: \(seconds); peak resident memory: \(memory)") { _ in }
        let elapsed = number(in: seconds)
        let peakMB = number(in: memory)
        XCTAssertNotNil(elapsed)
        XCTAssertNotNil(peakMB)
        XCTAssertLessThan(elapsed ?? .infinity, 10)
        XCTAssertGreaterThan(peakMB ?? 0, 0)
        XCTAssertLessThan(peakMB ?? .infinity, 500)
    }

    private func number(in label: String) -> Double? {
        guard let range = label.range(of: #"[0-9]+([.,][0-9]+)?"#, options: .regularExpression) else {
            return nil
        }
        return Double(label[range].replacingOccurrences(of: ",", with: "."))
    }
}
