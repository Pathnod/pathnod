// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "PathnodIOS",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "PathnodAppAttest", targets: ["PathnodAppAttest"]),
        .library(name: "PathnodDensityCore", targets: ["PathnodDensityCore"]),
        .library(name: "PathnodChallengeCore", targets: ["PathnodChallengeCore"]),
        .library(name: "PathnodObserverEnrollment", targets: ["PathnodObserverEnrollment"]),
        .library(name: "PathnodObservationCore", targets: ["PathnodObservationCore"]),
    ],
    targets: [
        .target(name: "PathnodAppAttest"),
        .testTarget(
            name: "PathnodAppAttestTests",
            dependencies: ["PathnodAppAttest"]
        ),
        .target(name: "PathnodDensityCore"),
        .testTarget(
            name: "PathnodDensityCoreTests",
            dependencies: ["PathnodDensityCore"]
        ),
        .target(name: "PathnodChallengeCore"),
        .testTarget(
            name: "PathnodChallengeCoreTests",
            dependencies: ["PathnodChallengeCore"]
        ),
        .target(name: "PathnodObserverEnrollment", resources: [.process("Resources")]),
        .testTarget(name: "PathnodObserverEnrollmentTests", dependencies: ["PathnodObserverEnrollment"]),
        .target(name: "PathnodObservationCore", dependencies: ["PathnodChallengeCore", "PathnodObserverEnrollment"]),
        .testTarget(name: "PathnodObservationCoreTests", dependencies: ["PathnodObservationCore"]),
    ]
)
