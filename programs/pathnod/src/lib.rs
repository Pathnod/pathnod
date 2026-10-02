//! Pathnod on-chain program.
//!
//! DEV-15 is a development-only Groth16 compatibility/CU spike, NOT an
//! observation acceptance endpoint. Its caller-selected keys confer no trust.

use anchor_lang::prelude::*;
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};

declare_id!("5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd");

#[program]
pub mod pathnod {
    use super::*;

    /// No-op instruction used to prove that the pinned toolchain builds,
    /// generates an IDL and produces a loadable SBF binary.
    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        msg!("pathnod: toolchain baseline ok");
        Ok(())
    }

    /// Immutable, authority-scoped key for a disposable benchmark setup.
    pub fn initialize_groth16_spike(
        ctx: Context<InitializeGroth16Spike>,
        key: VerificationKeyData,
    ) -> Result<()> {
        ctx.accounts.config.authority = ctx.accounts.authority.key();
        ctx.accounts.config.key = key;
        Ok(())
    }

    /// Seven inputs: root, protocol ID, device ID, epoch, nullifier,
    /// pseudonym, hardware class. All are canonical 32-byte big-endian Fr.
    /// The client must negate proof A before submission.
    pub fn verify_groth16_spike(
        ctx: Context<VerifyGroth16Spike>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        public_inputs: [[u8; 32]; 7],
    ) -> Result<()> {
        let key = &ctx.accounts.config.key;
        let vk = Groth16Verifyingkey {
            // The crate's key metadata includes the constant IC[0] term.
            nr_pubinputs: 8,
            vk_alpha_g1: key.alpha,
            vk_beta_g2: key.beta,
            vk_gamme_g2: key.gamma,
            vk_delta_g2: key.delta,
            vk_ic: &key.ic,
        };
        log_compute_units();
        let mut verifier = Groth16Verifier::new(&proof_a, &proof_b, &proof_c, &public_inputs, &vk)
            .map_err(|_| error!(SpikeError::InvalidProof))?;
        verifier
            .verify()
            .map_err(|_| error!(SpikeError::InvalidProof))?;
        log_compute_units();
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct VerificationKeyData {
    pub alpha: [u8; 64],
    pub beta: [u8; 128],
    pub gamma: [u8; 128],
    pub delta: [u8; 128],
    pub ic: [[u8; 64]; 8],
}

#[account]
pub struct Groth16SpikeConfig {
    pub authority: Pubkey,
    pub key: VerificationKeyData,
}

#[derive(Accounts)]
pub struct InitializeGroth16Spike<'info> {
    #[account(init, payer = authority, space = 8 + 32 + 960,
        seeds = [b"dev15-vk", authority.key().as_ref()], bump)]
    pub config: Account<'info, Groth16SpikeConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyGroth16Spike<'info> {
    #[account(seeds = [b"dev15-vk", config.authority.as_ref()], bump)]
    pub config: Account<'info, Groth16SpikeConfig>,
}

#[error_code]
pub enum SpikeError {
    #[msg("Invalid Groth16 proof, key or non-canonical public input")]
    InvalidProof,
}

fn log_compute_units() {
    #[cfg(target_os = "solana")]
    // SAFETY: the runtime exposes this read-only syscall on SBF.
    unsafe {
        solana_define_syscall::definitions::sol_log_compute_units_();
    }
    #[cfg(not(target_os = "solana"))]
    {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use groth16_solana::errors::Groth16Error;

    fn zero_key() -> VerificationKeyData {
        VerificationKeyData {
            alpha: [0; 64],
            beta: [0; 128],
            gamma: [0; 128],
            delta: [0; 128],
            ic: [[0; 64]; 8],
        }
    }

    #[test]
    fn verification_key_has_fixed_borsh_layout() {
        let key = zero_key();
        let mut encoded = Vec::new();
        key.serialize(&mut encoded).unwrap();
        assert_eq!(encoded.len(), 960);
        let decoded = VerificationKeyData::try_from_slice(&encoded).unwrap();
        assert_eq!(decoded.ic.len(), 8);
        assert!(VerificationKeyData::try_from_slice(&encoded[..959]).is_err());
    }

    #[test]
    fn checked_verifier_rejects_noncanonical_public_scalar() {
        let key = zero_key();
        let vk = Groth16Verifyingkey {
            nr_pubinputs: 8,
            vk_alpha_g1: key.alpha,
            vk_beta_g2: key.beta,
            vk_gamme_g2: key.gamma,
            vk_delta_g2: key.delta,
            vk_ic: &key.ic,
        };
        let a = [0; 64];
        let b = [0; 128];
        let c = [0; 64];
        let mut inputs = [[0; 32]; 7];
        inputs[0] = [255; 32];
        let mut verifier = Groth16Verifier::new(&a, &b, &c, &inputs, &vk).unwrap();
        assert_eq!(
            verifier.verify(),
            Err(Groth16Error::PublicInputGreaterThanFieldSize)
        );
    }
}
