//! Verifier authorization digests shared with the Ed25519 consumer.
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

pub fn observation_authorization_with_evidence_digest(
    transcript_hash: &[u8; 32],
    evidence_hash: &[u8; 32],
    nullifier: &[u8; 32],
    pseudonym: &[u8; 32],
    class: u8,
    policy_version: u32,
) -> Result<[u8; 32]> {
    if *evidence_hash == [0; 32] {
        return observation_authorization_digest(
            transcript_hash,
            nullifier,
            pseudonym,
            class,
            policy_version,
        );
    }
    observation_authorization_digest(transcript_hash, nullifier, pseudonym, class, policy_version)?;
    Ok(hashv(&[
        b"Pathnod/verified/v1",
        transcript_hash,
        evidence_hash,
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

    #[test]
    fn shared_evidence_signature_digest_and_zero_compatibility() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/observations/verifier-authorization-v1.json"
        ))
        .unwrap();
        let mut nullifier = [0; 32];
        nullifier[31] = 0x22;
        let mut pseudonym = [0; 32];
        pseudonym[31] = 0x33;
        let digest = observation_authorization_with_evidence_digest(
            &[0x11; 32],
            &[0x44; 32],
            &nullifier,
            &pseudonym,
            1,
            0x01020304,
        )
        .unwrap();
        let encoded = digest
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>();
        assert_eq!(encoded, fixture["digest"].as_str().unwrap());
        assert_eq!(
            observation_authorization_with_evidence_digest(
                &[0x11; 32],
                &[0; 32],
                &nullifier,
                &pseudonym,
                1,
                1
            )
            .unwrap(),
            observation_authorization_digest(&[0x11; 32], &nullifier, &pseudonym, 1, 1).unwrap()
        );
    }
}
