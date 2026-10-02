#[derive(Debug, thiserror::Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum MoproError {
    #[error("CircomError: {0}")]
    CircomError(String),
}
