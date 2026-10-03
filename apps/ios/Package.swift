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
    ]
)
