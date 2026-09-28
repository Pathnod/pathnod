import SwiftUI

@main
struct PathnodChallengeScanApp: App {
    @StateObject private var controller = ChallengeBLEController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ChallengeScanView(controller: controller)
        }
        .onChange(of: scenePhase) { phase in
            controller.handleScenePhase(phase)
        }
    }
}
