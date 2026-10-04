import XCTest

final class AppAttestSpikeUITests: XCTestCase {
    @MainActor
    func testRealAppAttestTrialOnDevice() {
        let app = XCUIApplication()
        app.launchEnvironment["APP_ATTEST_KEYCHAIN_SERVICE"] = "xyz.pathnod.appattestspike.uitest.\(UUID().uuidString)"
        app.launch()
        runTrial(in: app)
        let firstKey = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "New key fingerprint")).firstMatch.label
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Returned ")).firstMatch.exists)

        app.terminate()
        app.launch()
        runTrial(in: app)
        let reusedKey = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Reused key fingerprint")).firstMatch.label
        XCTAssertEqual(reusedKey.suffix(8), firstKey.suffix(8))
        XCTAssertTrue(app.staticTexts["Returned on a previous run"].exists)
    }

    @MainActor
    private func runTrial(in app: XCUIApplication) {
        app.buttons["runAppAttestTrial"].tap()
        let succeeded = NSPredicate(format: "label == %@", "Succeeded")
        expectation(for: succeeded, evaluatedWith: app.staticTexts["appAttestStatus"])
        waitForExpectations(timeout: 120)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Two distinct challenges:")).firstMatch.exists)
    }
}
