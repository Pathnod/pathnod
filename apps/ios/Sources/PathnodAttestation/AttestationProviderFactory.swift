public enum AttestationProviderFactory {
    public static func make(
        configuredProvider: String?,
        buildConfiguration: AttestationBuildConfiguration = .current,
        logger: any AttestationWarningLogging = ConsoleAttestationWarningLogger()
    ) throws -> any AttestationProvider {
        guard let configuredProvider, !configuredProvider.isEmpty else {
            throw AttestationProviderError.stubDisabled
        }
        guard configuredProvider == DevelopmentStubAttestationProvider.providerIdentifier else {
            throw AttestationProviderError.unsupportedProvider
        }
        guard buildConfiguration == .debug else {
            throw AttestationProviderError.stubForbiddenInRelease
        }

        return try DevelopmentStubAttestationProvider(logger: logger)
    }
}
