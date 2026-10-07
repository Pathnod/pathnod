//! DEV-34 signing ABI only. DEV-35 must enforce this with the Ed25519 precompile.
use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

pub fn observation_authorization_digest(
    transcript_hash: &[u8; 32],
    nullifier: &[u8; 32],
    pseudonym: &[u8; 32],
    class: u8,
    policy_version: u32,
) -> Result<[u8; 32]> {
    require!(
        (1..=3).contains(&class) && policy_version > 0,
        crate::PathnodError::InvalidPolicy
    );
    require!(
        *nullifier < crate::registry::FIELD_MODULUS_BE
            && *pseudonym < crate::registry::FIELD_MODULUS_BE,
        crate::PathnodError::InvalidPolicy
    );
    Ok(hashv(&[
        b"Pathnod/verified/v0",
        transcript_hash,
        nullifier,
        pseudonym,
        &[class],
        &policy_version.to_le_bytes(),
    ])
    .to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_dev34_signature_digest() {
        let fixture = include_str!("../../../fixtures/observations/verifier-authorization-v0.json");
        let mut nullifier = [0; 32];
        nullifier[31] = 0x22;
        let mut pseudonym = [0; 32];
        pseudonym[31] = 0x33;
        let digest =
            observation_authorization_digest(&[0x11; 32], &nullifier, &pseudonym, 1, 0x01020304)
                .unwrap();
        let expected = fixture
            .split("\"digest\": \"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        let actual = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(actual, expected);
        assert!(
            observation_authorization_digest(&[0x11; 32], &nullifier, &pseudonym, 0, 1).is_err()
        );
        assert!(
            observation_authorization_digest(&[0x11; 32], &nullifier, &pseudonym, 1, 0).is_err()
        );
    }
}
