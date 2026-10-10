use crate::PathnodError;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, InitializeAccount3, Mint, Token, TokenAccount};
use solana_sha256_hasher::hashv;

const MAX_OBSERVERS: u32 = 1 << 20;
pub(crate) const FIELD_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProtocolConfigArgs {
    pub protocol_id: [u8; 32],
    pub epoch_seconds: u32,
    pub verifier_pubkey: Pubkey,
    pub policy_version: u32,
    pub reward_per_slot: u64,
    pub slots_per_epoch: u8,
}

impl ProtocolConfigArgs {
    fn validate(&self) -> Result<()> {
        require!(self.protocol_id != [0; 32], PathnodError::InvalidProtocol);
        require!(self.epoch_seconds > 0, PathnodError::InvalidPolicy);
        require!(self.policy_version > 0, PathnodError::InvalidPolicy);
        require_keys_neq!(
            self.verifier_pubkey,
            Pubkey::default(),
            PathnodError::InvalidPolicy
        );
        require!(
            self.slots_per_epoch == 0 || self.reward_per_slot > 0,
            PathnodError::InvalidPolicy
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterDeviceArgs {
    pub device_id: [u8; 32],
    pub k_dev: [u8; 32],
    pub curve: u8,
    pub external_asset: Option<Pubkey>,
    pub proof_of_control: Option<Vec<u8>>,
    pub capabilities: u32,
    pub claimed_geohash6: Option<[u8; 6]>,
}

impl RegisterDeviceArgs {
    fn validate(&self) -> Result<()> {
        require!(self.curve == 1, PathnodError::UnsupportedCurve);
        require!(self.k_dev != [0; 32], PathnodError::InvalidDevice);
        require!(
            self.device_id == derive_device_id(&self.k_dev),
            PathnodError::InvalidDevice
        );
        if let Some(proof) = &self.proof_of_control {
            crate::asset_control::CnftControlProof::decode(proof)?;
            require!(
                self.external_asset.is_some(),
                PathnodError::InvalidExternalAssetProof
            );
        }
        if let Some(asset) = self.external_asset {
            require_keys_neq!(asset, Pubkey::default(), PathnodError::InvalidDevice);
        }
        if let Some(geohash) = self.claimed_geohash6 {
            require!(
                geohash
                    .iter()
                    .all(|byte| b"0123456789bcdefghjkmnpqrstuvwxyz".contains(byte)),
                PathnodError::InvalidGeohash
            );
        }
        Ok(())
    }
}

pub fn derive_device_id(key: &[u8; 32]) -> [u8; 32] {
    hashv(&[b"Pathnod/device/v0", key]).to_bytes()
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub protocol_id: [u8; 32],
    pub epoch_seconds: u32,
    pub verifier_pubkey: Pubkey,
    pub policy_version: u32,
    pub reward_mint: Pubkey,
    pub reward_per_slot: u64,
    pub slots_per_epoch: u8,
    pub escrow_vault: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct DeviceRegistry {
    pub device_id: [u8; 32],
    pub k_dev: [u8; 32],
    pub curve: u8,
    pub external_asset: Option<Pubkey>,
    pub linked: bool,
    pub registered_at: i64,
    pub capabilities: u32,
    pub claimed_geohash6: Option<[u8; 6]>,
}

#[account]
#[derive(InitSpace)]
pub struct ObserverRoot {
    pub root: [u8; 32],
    pub leaf_count: u32,
    pub published_at: i64,
    pub enrollment_authority: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct EnrollmentAuthority {
    pub authority: Pubkey,
    pub publications: u64,
    pub recent_roots: [[u8; 32]; 4],
}

#[derive(Accounts)]
pub struct InitializeEnrollmentAuthority<'info> {
    #[account(init, payer = upgrade_authority, space = 8 + EnrollmentAuthority::INIT_SPACE,
        seeds = [b"enrollment-authority"], bump)]
    pub enrollment: Account<'info, EnrollmentAuthority>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ PathnodError::Unauthorized)]
    pub program: Program<'info, crate::program::Pathnod>,
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ PathnodError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ProtocolConfigArgs)]
pub struct InitProtocol<'info> {
    #[account(init, payer = authority, space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [b"protocol", args.protocol_id.as_ref()], bump)]
    pub config: Account<'info, ProtocolConfig>,
    /// CHECK: created with the legacy Token program as owner and initialized by its CPI below.
    #[account(init, payer = authority, space = TokenAccount::LEN,
        owner = token_program.key(), seeds = [b"escrow", args.protocol_id.as_ref()], bump)]
    pub escrow_vault: UncheckedAccount<'info>,
    #[account(constraint = reward_mint.decimals == 6 @ PathnodError::InvalidMint)]
    pub reward_mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: RegisterDeviceArgs)]
pub struct RegisterDevice<'info> {
    #[account(seeds = [b"protocol", config.protocol_id.as_ref()], bump,
        has_one = authority @ PathnodError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(init, payer = authority, space = 8 + DeviceRegistry::INIT_SPACE,
        seeds = [b"device", config.protocol_id.as_ref(), args.device_id.as_ref()], bump)]
    pub device: Account<'info, DeviceRegistry>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(root: [u8; 32])]
pub struct PublishRoot<'info> {
    #[account(mut, seeds = [b"enrollment-authority"], bump,
        has_one = authority @ PathnodError::Unauthorized)]
    pub enrollment: Account<'info, EnrollmentAuthority>,
    #[account(init, payer = authority, space = 8 + ObserverRoot::INIT_SPACE,
        seeds = [b"root", root.as_ref()], bump)]
    pub observer_root: Account<'info, ObserverRoot>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_enrollment_authority(
    ctx: Context<InitializeEnrollmentAuthority>,
    authority: Pubkey,
) -> Result<()> {
    require_keys_neq!(authority, Pubkey::default(), PathnodError::InvalidAuthority);
    ctx.accounts.enrollment.authority = authority;
    ctx.accounts.enrollment.publications = 0;
    ctx.accounts.enrollment.recent_roots = [[0; 32]; 4];
    Ok(())
}

pub fn handle_init_protocol(ctx: Context<InitProtocol>, args: ProtocolConfigArgs) -> Result<()> {
    args.validate()?;
    token::initialize_account3(CpiContext::new(
        ctx.accounts.token_program.key(),
        InitializeAccount3 {
            account: ctx.accounts.escrow_vault.to_account_info(),
            mint: ctx.accounts.reward_mint.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        },
    ))?;
    ctx.accounts.config.set_inner(ProtocolConfig {
        authority: ctx.accounts.authority.key(),
        protocol_id: args.protocol_id,
        epoch_seconds: args.epoch_seconds,
        verifier_pubkey: args.verifier_pubkey,
        policy_version: args.policy_version,
        reward_mint: ctx.accounts.reward_mint.key(),
        reward_per_slot: args.reward_per_slot,
        slots_per_epoch: args.slots_per_epoch,
        escrow_vault: ctx.accounts.escrow_vault.key(),
    });
    Ok(())
}

pub fn handle_register_device(
    ctx: Context<RegisterDevice>,
    args: RegisterDeviceArgs,
) -> Result<()> {
    args.validate()?;
    let linked = args.proof_of_control.is_some();
    if linked {
        crate::asset_control::verify_control(
            &ctx.accounts.authority.key(),
            &ctx.accounts.config.protocol_id,
            &args,
            ctx.remaining_accounts,
            Clock::get()?.unix_timestamp,
        )?;
    } else {
        require!(
            ctx.remaining_accounts.is_empty(),
            PathnodError::InvalidExternalAssetProof
        );
    }
    ctx.accounts.device.set_inner(DeviceRegistry {
        device_id: args.device_id,
        k_dev: args.k_dev,
        curve: args.curve,
        external_asset: args.external_asset,
        linked,
        registered_at: Clock::get()?.unix_timestamp,
        capabilities: args.capabilities,
        claimed_geohash6: args.claimed_geohash6,
    });
    Ok(())
}

pub fn handle_publish_root(
    ctx: Context<PublishRoot>,
    root: [u8; 32],
    leaf_count: u32,
) -> Result<()> {
    require!(root < FIELD_MODULUS_BE, PathnodError::InvalidRoot);
    require!(leaf_count <= MAX_OBSERVERS, PathnodError::InvalidLeafCount);
    let state = &mut ctx.accounts.enrollment;
    let index = (state.publications % 4) as usize;
    state.publications = state
        .publications
        .checked_add(1)
        .ok_or(PathnodError::PublicationOverflow)?;
    state.recent_roots[index] = root;
    ctx.accounts.observer_root.set_inner(ObserverRoot {
        root,
        leaf_count,
        published_at: Clock::get()?.unix_timestamp,
        enrollment_authority: ctx.accounts.authority.key(),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_domain_matches_the_ble_identity_vector() {
        let key = [
            0x58, 0x38, 0x89, 0x4a, 0x70, 0x84, 0x3a, 0x93, 0x79, 0x76, 0x15, 0x6c, 0xb1, 0x18,
            0x3f, 0x86, 0x35, 0x84, 0x0f, 0x1d, 0xe0, 0x6c, 0x01, 0x1d, 0xbe, 0xa1, 0x28, 0x26,
            0xef, 0xbf, 0x30, 0xce,
        ];
        assert_eq!(
            derive_device_id(&key),
            [
                0x2b, 0x52, 0xd0, 0x36, 0x96, 0x22, 0x19, 0xb5, 0x19, 0x54, 0x12, 0xa3, 0x39, 0x50,
                0x04, 0x4c, 0x74, 0x76, 0x66, 0xea, 0xc5, 0xd9, 0xe8, 0x8d, 0xdf, 0xa3, 0x9d, 0xc6,
                0x13, 0xb0, 0x49, 0xb8,
            ]
        );
    }

    #[test]
    fn free_protocols_are_valid_and_paid_slots_require_a_reward() {
        let mut args = ProtocolConfigArgs {
            protocol_id: [1; 32],
            epoch_seconds: 604800,
            verifier_pubkey: Pubkey::new_unique(),
            policy_version: 1,
            reward_per_slot: 0,
            slots_per_epoch: 0,
        };
        assert!(args.validate().is_ok());
        args.slots_per_epoch = 3;
        assert!(args.validate().is_err());
        args.reward_per_slot = 50_000;
        assert!(args.validate().is_ok());
        args.verifier_pubkey = Pubkey::default();
        assert!(args.validate().is_err());
    }

    #[test]
    fn device_options_fit_the_fixed_account_allocation() {
        let device = DeviceRegistry {
            device_id: [1; 32],
            k_dev: [2; 32],
            curve: 1,
            external_asset: Some(Pubkey::new_unique()),
            linked: false,
            registered_at: 1,
            capabilities: 2,
            claimed_geohash6: Some(*b"u09tvw"),
        };
        let mut data = Vec::new();
        device.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), 126);
        assert_eq!(DeviceRegistry::INIT_SPACE + 8, data.len());
        assert_eq!(ProtocolConfig::INIT_SPACE + 8, 185);
        assert_eq!(ObserverRoot::INIT_SPACE + 8, 84);
        assert_eq!(EnrollmentAuthority::INIT_SPACE + 8, 176);
    }
}
