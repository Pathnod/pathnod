use crate::{
    observation::check_ed25519_authorization, DeviceEpoch, DeviceRegistry, PathnodError,
    ProtocolConfig,
};
use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PublishConfidenceArgs {
    pub epoch: u32,
    pub observation_root: [u8; 32],
    pub observer_count: u16,
    pub previous_commitment: [u8; 32],
    pub commitment: [u8; 32],
    pub policy_version: u32,
    pub evaluated_at_ms: u64,
}

#[derive(Accounts)]
#[instruction(args: PublishConfidenceArgs)]
pub struct PublishConfidence<'info> {
    #[account(seeds = [b"protocol", config.protocol_id.as_ref()], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(seeds = [b"device", config.protocol_id.as_ref(), device.device_id.as_ref()], bump)]
    pub device: Account<'info, DeviceRegistry>,
    #[account(mut, seeds = [b"epoch", config.protocol_id.as_ref(), device.device_id.as_ref(), args.epoch.to_le_bytes().as_ref()], bump)]
    pub device_epoch: Account<'info, DeviceEpoch>,
    /// CHECK: fixed runtime Instructions sysvar; the handler checks top-level adjacency.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn confidence_authorization_digest(
    program: &Pubkey,
    protocol: &[u8; 32],
    device: &[u8; 32],
    args: &PublishConfidenceArgs,
) -> [u8; 32] {
    hashv(&[
        b"Pathnod/confidence-authorization/v0",
        program.as_ref(),
        protocol,
        device,
        &args.epoch.to_le_bytes(),
        &args.observation_root,
        &args.observer_count.to_le_bytes(),
        &args.previous_commitment,
        &args.commitment,
        &args.policy_version.to_le_bytes(),
        &args.evaluated_at_ms.to_le_bytes(),
    ])
    .to_bytes()
}

fn validate_state(
    state: &DeviceEpoch,
    args: &PublishConfidenceArgs,
    policy_version: u32,
    epoch_seconds: u32,
    now: i64,
) -> Result<()> {
    require!(
        args.policy_version == policy_version && args.commitment != [0; 32],
        PathnodError::InvalidPolicy
    );
    require!(
        args.observer_count > 0
            && state.independent_observers == args.observer_count
            && state.observation_root == args.observation_root,
        PathnodError::StaleConfidence
    );
    require!(
        state.confidence_commitment == args.previous_commitment,
        PathnodError::StaleConfidence
    );
    let evaluated_seconds = args.evaluated_at_ms / 1000;
    let epoch_start = u64::from(args.epoch) * u64::from(epoch_seconds);
    require!(
        now >= 0 && evaluated_seconds >= epoch_start && evaluated_seconds <= now as u64 + 600,
        PathnodError::InvalidPolicy
    );
    Ok(())
}

pub fn handle_publish(ctx: Context<PublishConfidence>, args: PublishConfidenceArgs) -> Result<()> {
    validate_state(
        &ctx.accounts.device_epoch,
        &args,
        ctx.accounts.config.policy_version,
        ctx.accounts.config.epoch_seconds,
        Clock::get()?.unix_timestamp,
    )?;
    let digest = confidence_authorization_digest(
        &crate::ID,
        &ctx.accounts.config.protocol_id,
        &ctx.accounts.device.device_id,
        &args,
    );
    check_ed25519_authorization(
        &ctx.accounts.instructions,
        &ctx.accounts.config.verifier_pubkey,
        &digest,
        crate::instruction::PublishConfidence::DISCRIMINATOR,
    )?;
    ctx.accounts.device_epoch.confidence_commitment = args.commitment;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confidence_authorization_matches_the_shared_independent_vector() {
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/confidence/authorization-v0.json"
        ))
        .unwrap();
        let a = PublishConfidenceArgs {
            epoch: 42,
            observation_root: [4; 32],
            observer_count: 3,
            previous_commitment: [5; 32],
            commitment: [6; 32],
            policy_version: 7,
            evaluated_at_ms: 123456789,
        };
        let hash = confidence_authorization_digest(
            &Pubkey::new_from_array([1; 32]),
            &[2; 32],
            &[3; 32],
            &a,
        );
        let encoded = hash.iter().map(|v| format!("{v:02x}")).collect::<String>();
        assert_eq!(encoded, vector["sha256"].as_str().unwrap());
    }
    fn state() -> DeviceEpoch {
        DeviceEpoch {
            independent_observers: 1,
            paid_slots_used: 1,
            observation_root: [1; 32],
            confidence_commitment: [0; 32],
            frontier: [[0; 32]; 16],
        }
    }
    fn args() -> PublishConfidenceArgs {
        PublishConfidenceArgs {
            epoch: 1,
            observation_root: [1; 32],
            observer_count: 1,
            previous_commitment: [0; 32],
            commitment: [2; 32],
            policy_version: 3,
            evaluated_at_ms: 100_000,
        }
    }
    #[test]
    fn confidence_is_bound_to_current_tree_count_policy_and_previous_hash() {
        let mut s = state();
        let a = args();
        assert!(validate_state(&s, &a, 3, 100, 100).is_ok());
        s.independent_observers = 2;
        assert!(validate_state(&s, &a, 3, 100, 100).is_err());
        s = state();
        s.observation_root = [9; 32];
        assert!(validate_state(&s, &a, 3, 100, 100).is_err());
        s = state();
        s.confidence_commitment = [9; 32];
        assert!(validate_state(&s, &a, 3, 100, 100).is_err());
        s = state();
        assert!(validate_state(&s, &a, 4, 100, 100).is_err());
        let mut a = args();
        a.evaluated_at_ms = 701_000;
        assert!(validate_state(&s, &a, 3, 100, 100).is_err());
        a = args();
        a.commitment = [0; 32];
        assert!(validate_state(&s, &a, 3, 100, 100).is_err());
    }
    #[test]
    fn a_new_observation_invalidates_previously_published_confidence() {
        let mut s = state();
        s.confidence_commitment = [2; 32];
        crate::append_observation(&mut s, &[3; 32]).unwrap();
        assert_eq!(s.confidence_commitment, [0; 32]);
        assert_eq!(s.independent_observers, 2);
        assert_eq!(s.paid_slots_used, 1);
    }
}
