// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "PathnodAttestation",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "PathnodAttestation", targets: ["PathnodAttestation"]),
        .library(name: "PathnodDensityCore", targets: ["PathnodDensityCore"]),
        .library(name: "PathnodChallengeCore", targets: ["PathnodChallengeCore"]),
    ],
    targets: [
        .target(name: "PathnodAttestation"),
        .testTarget(
            name: "PathnodAttestationTests",
            dependencies: ["PathnodAttestation"]
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
