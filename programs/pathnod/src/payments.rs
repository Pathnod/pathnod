//! DEV-36: isolated token vaults, deployment-controlled fees and scoped withdrawals.
use crate::{EnrollmentAuthority, PathnodError, ProtocolConfig};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use solana_sha256_hasher::hashv;

#[account]
#[derive(InitSpace)]
pub struct PaymentSettings {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct Payout {
    pub protocol_id: [u8; 32],
    pub pseudonym: [u8; 32],
    pub mint: Pubkey,
    pub withdrawal_key: Pubkey,
    pub gross: u64,
    pub fees: u64,
    pub available: u64,
    pub withdrawn: u64,
    pub nonce: u64,
}

#[derive(Accounts)]
pub struct InitializePayments<'info> {
    #[account(init, payer = authority, space = 8 + PaymentSettings::INIT_SPACE, seeds = [b"payments"], bump)]
    pub settings: Account<'info, PaymentSettings>,
    #[account(seeds = [b"enrollment-authority"], bump, has_one = authority @ PathnodError::Unauthorized)]
    pub enrollment: Account<'info, EnrollmentAuthority>,
    #[account(constraint = mint.decimals == 6 @ PathnodError::InvalidMint)]
    pub mint: Account<'info, Mint>,
    /// CHECK: nonzero withdrawal authority for the fee vault; no protocol can redirect it.
    pub treasury: UncheckedAccount<'info>,
    #[account(init, payer = authority, seeds = [b"fees"], bump, token::mint = mint, token::authority = treasury)]
    pub fee_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFees<'info> {
    #[account(mut, seeds = [b"payments"], bump, has_one = authority @ PathnodError::Unauthorized)]
    pub settings: Account<'info, PaymentSettings>,
    pub authority: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdatePolicyArgs {
    pub policy_version: u32,
    pub verifier_pubkey: Pubkey,
    pub reward_per_slot: u64,
    pub slots_per_epoch: u8,
}
#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    #[account(mut, seeds = [b"protocol", config.protocol_id.as_ref()], bump, has_one = authority @ PathnodError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    pub authority: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimPayoutArgs {
    pub amount: u64,
    pub nonce: u64,
    pub expires_at: i64,
}
#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    #[account(seeds = [b"protocol", config.protocol_id.as_ref()], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [b"payout", config.protocol_id.as_ref(), payout.pseudonym.as_ref()], bump,
        constraint = payout.protocol_id == config.protocol_id @ PathnodError::InvalidPayout,
        constraint = payout.mint == config.reward_mint @ PathnodError::InvalidMint)]
    pub payout: Account<'info, Payout>,
    #[account(address = payout.mint, constraint = mint.decimals == 6 @ PathnodError::InvalidMint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"payout-vault", config.protocol_id.as_ref(), payout.pseudonym.as_ref()], bump,
        token::mint = mint, token::authority = payout)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = withdrawal_key,
        constraint = destination.key() != vault.key() @ PathnodError::InvalidPayout)]
    pub destination: Account<'info, TokenAccount>,
    pub withdrawal_key: Signer<'info>,
    /// CHECK: runtime instructions sysvar, used to verify first binding authorization.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn split_reward(gross: u64, fee_bps: u16) -> Result<(u64, u64)> {
    require!(fee_bps <= 10_000, PathnodError::InvalidPolicy);
    // Floor the fee; every base unit is conserved, including for u64::MAX.
    let fee = ((gross as u128) * u128::from(fee_bps) / 10_000) as u64;
    Ok((fee, gross - fee))
}
pub fn initialize(ctx: Context<InitializePayments>) -> Result<()> {
    require_keys_neq!(
        ctx.accounts.treasury.key(),
        Pubkey::default(),
        PathnodError::InvalidAuthority
    );
    ctx.accounts.settings.set_inner(PaymentSettings {
        authority: ctx.accounts.authority.key(),
        mint: ctx.accounts.mint.key(),
        treasury: ctx.accounts.treasury.key(),
        fee_bps: 2_000,
    });
    Ok(())
}
pub fn update_fees(ctx: Context<UpdateFees>, fee_bps: u16) -> Result<()> {
    split_reward(0, fee_bps)?;
    ctx.accounts.settings.fee_bps = fee_bps;
    Ok(())
}
pub fn update_policy(ctx: Context<UpdatePolicy>, args: UpdatePolicyArgs) -> Result<()> {
    require!(
        args.policy_version > ctx.accounts.config.policy_version
            && args.verifier_pubkey != Pubkey::default()
            && (args.slots_per_epoch == 0 || args.reward_per_slot > 0),
        PathnodError::InvalidPolicy
    );
    let config = &mut ctx.accounts.config;
    config.policy_version = args.policy_version;
    config.verifier_pubkey = args.verifier_pubkey;
    config.reward_per_slot = args.reward_per_slot;
    config.slots_per_epoch = args.slots_per_epoch;
    Ok(())
}
pub fn claim_digest(
    program: &Pubkey,
    payout: &Pubkey,
    mint: &Pubkey,
    withdrawal: &Pubkey,
    destination: &Pubkey,
    args: &ClaimPayoutArgs,
    policy_version: u32,
) -> [u8; 32] {
    hashv(&[
        b"Pathnod/claim/v0",
        program.as_ref(),
        payout.as_ref(),
        mint.as_ref(),
        withdrawal.as_ref(),
        destination.as_ref(),
        &args.amount.to_le_bytes(),
        &args.nonce.to_le_bytes(),
        &args.expires_at.to_le_bytes(),
        &policy_version.to_le_bytes(),
    ])
    .to_bytes()
}
pub fn claim(ctx: Context<ClaimPayout>, args: ClaimPayoutArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        args.amount > 0
            && args.amount <= ctx.accounts.payout.available
            && args.nonce == ctx.accounts.payout.nonce
            && args.expires_at >= now
            && args.expires_at <= now.saturating_add(300),
        PathnodError::InvalidPayout
    );
    let key = ctx.accounts.withdrawal_key.key();
    if ctx.accounts.payout.withdrawal_key == Pubkey::default() {
        let digest = claim_digest(
            &crate::ID,
            &ctx.accounts.payout.key(),
            &ctx.accounts.mint.key(),
            &key,
            &ctx.accounts.destination.key(),
            &args,
            ctx.accounts.config.policy_version,
        );
        crate::observation::check_ed25519_authorization(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.config.verifier_pubkey,
            &digest,
            crate::instruction::ClaimPayout::DISCRIMINATOR,
        )?;
    } else {
        require_keys_eq!(
            ctx.accounts.payout.withdrawal_key,
            key,
            PathnodError::Unauthorized
        );
    }
    let protocol = ctx.accounts.payout.protocol_id;
    let pseudonym = ctx.accounts.payout.pseudonym;
    let bump = [ctx.bumps.payout];
    let seeds: &[&[u8]] = &[b"payout", &protocol, &pseudonym, &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.payout.to_account_info(),
            },
            &[seeds],
        ),
        args.amount,
        6,
    )?;
    let payout = &mut ctx.accounts.payout;
    payout.available -= args.amount;
    payout.withdrawn = payout
        .withdrawn
        .checked_add(args.amount)
        .ok_or(PathnodError::PaymentOverflow)?;
    payout.nonce = payout
        .nonce
        .checked_add(1)
        .ok_or(PathnodError::PaymentOverflow)?;
    payout.withdrawal_key = key;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rounding_conserves_all_units() {
        for gross in [0, 1, 4, 5, 49_999, 50_000, u64::MAX] {
            for bps in [0, 2_000, 10_000] {
                let (fee, net) = split_reward(gross, bps).unwrap();
                assert_eq!(fee as u128 + net as u128, gross as u128);
            }
        }
        assert_eq!(split_reward(50_000, 2_000).unwrap(), (10_000, 40_000));
        assert!(split_reward(1, 10_001).is_err());
    }
    #[test]
    fn claims_bind_destination_amount_nonce_expiry_policy_and_program() {
        let keys: Vec<_> = (0..5).map(|_| Pubkey::new_unique()).collect();
        let args = ClaimPayoutArgs {
            amount: 40_000,
            nonce: 0,
            expires_at: 100,
        };
        let digest = claim_digest(&keys[0], &keys[1], &keys[2], &keys[3], &keys[4], &args, 1);
        assert_ne!(
            digest,
            claim_digest(
                &keys[0],
                &keys[1],
                &keys[2],
                &keys[3],
                &Pubkey::new_unique(),
                &args,
                1
            )
        );
        for args in [
            ClaimPayoutArgs {
                amount: 1,
                ..args.clone()
            },
            ClaimPayoutArgs {
                nonce: 1,
                ..args.clone()
            },
            ClaimPayoutArgs {
                expires_at: 101,
                ..args.clone()
            },
        ] {
            assert_ne!(
                digest,
                claim_digest(&keys[0], &keys[1], &keys[2], &keys[3], &keys[4], &args, 1)
            );
        }
        assert_ne!(
            digest,
            claim_digest(&keys[0], &keys[1], &keys[2], &keys[3], &keys[4], &args, 2)
        );
    }
    #[test]
    fn claim_digest_matches_the_public_sdk_and_swift_vector() {
        let p = |s: &str| s.parse::<Pubkey>().unwrap();
        let digest = claim_digest(
            &p("CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8"),
            &p("AGGT4SQQbdH7yYTpYb485EfqnxkcbHceVTrgqJx58EsQ"),
            &p("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
            &p("AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9"),
            &p("QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF"),
            &ClaimPayoutArgs {
                amount: 40_000,
                nonce: 0,
                expires_at: 2_000_000_000,
            },
            1,
        );
        assert_eq!(
            digest
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            "a7da9ef72222986cab8085e6c3b13fb334544bc0402bbc254da4a378f44cde89"
        );
    }
}
