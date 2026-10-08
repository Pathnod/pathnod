use crate::{
    authorization::observation_authorization_with_evidence_digest, registry::FIELD_MODULUS_BE,
    trusted_vk, DeviceRegistry, EnrollmentAuthority, ObserverRoot, PathnodError, ProtocolConfig,
};
use crate::{PaymentSettings, Payout};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use groth16_solana::groth16::Groth16Verifier;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_poseidon::{hashv as poseidon, Endianness, Parameters};
use solana_sha256_hasher::hashv;

pub const EPOCH_TREE_DEPTH: usize = 16;
const ED25519_PROGRAM: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SubmitObservationArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub public_inputs: [[u8; 32]; 7],
    pub transcript_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
}
impl SubmitObservationArgs {
    pub fn epoch(&self) -> u32 {
        let bytes = &self.public_inputs[3];
        u32::from_be_bytes([bytes[28], bytes[29], bytes[30], bytes[31]])
    }
    pub fn epoch_seed(&self) -> [u8; 4] {
        self.epoch().to_le_bytes()
    }
}

#[account]
#[derive(InitSpace)]
pub struct ObservationVerifierInfo {
    pub key_digest: [u8; 32],
    pub abi_version: u8,
    pub public_inputs: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ObservationCommitment {
    pub protocol_id: [u8; 32],
    pub device_id: [u8; 32],
    pub epoch: u32,
    pub nullifier: [u8; 32],
    pub pseudonym: [u8; 32],
    pub class: u8,
    pub transcript_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
    pub slot_paid: bool,
    pub submitted_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct DeviceEpoch {
    pub independent_observers: u16,
    pub paid_slots_used: u8,
    pub observation_root: [u8; 32],
    pub confidence_commitment: [u8; 32],
    pub frontier: [[u8; 32]; EPOCH_TREE_DEPTH],
}

#[derive(Accounts)]
pub struct InitializeObservationVerifier<'info> {
    #[account(init_if_needed, payer = authority, space = 8 + ObservationVerifierInfo::INIT_SPACE,
        seeds = [b"observation-verifier"], bump)]
    pub verifier_info: Account<'info, ObservationVerifierInfo>,
    #[account(seeds = [b"enrollment-authority"], bump, has_one = authority @ PathnodError::Unauthorized)]
    pub enrollment: Account<'info, EnrollmentAuthority>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: SubmitObservationArgs)]
pub struct SubmitObservation<'info> {
    #[account(seeds = [b"protocol", config.protocol_id.as_ref()], bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"device", config.protocol_id.as_ref(), device.device_id.as_ref()], bump)]
    pub device: Box<Account<'info, DeviceRegistry>>,
    #[account(seeds = [b"enrollment-authority"], bump)]
    pub enrollment: Box<Account<'info, EnrollmentAuthority>>,
    #[account(seeds = [b"root", args.public_inputs[0].as_ref()], bump)]
    pub observer_root: Box<Account<'info, ObserverRoot>>,
    #[account(init_if_needed, payer = relayer, space = 8 + ObservationCommitment::INIT_SPACE,
        seeds = [b"obs", args.public_inputs[4].as_ref()], bump)]
    pub commitment: Box<Account<'info, ObservationCommitment>>,
    #[account(init_if_needed, payer = relayer, space = 8 + DeviceEpoch::INIT_SPACE,
        seeds = [b"epoch", config.protocol_id.as_ref(), device.device_id.as_ref(), args.epoch_seed().as_ref()], bump)]
    pub device_epoch: Box<Account<'info, DeviceEpoch>>,
    /// CHECK: constrained to the runtime's Instructions sysvar, accessed using checked introspection.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [b"payments"], bump, constraint = settings.mint == config.reward_mint @ PathnodError::InvalidMint)]
    pub settings: Box<Account<'info, PaymentSettings>>,
    #[account(address = config.reward_mint, constraint = mint.decimals == 6 @ PathnodError::InvalidMint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, address = config.escrow_vault, seeds = [b"escrow", config.protocol_id.as_ref()], bump,
        token::mint = mint, token::authority = config)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = relayer, space = 8 + Payout::INIT_SPACE,
        seeds = [b"payout", config.protocol_id.as_ref(), args.public_inputs[5].as_ref()], bump)]
    pub payout: Box<Account<'info, Payout>>,
    #[account(init_if_needed, payer = relayer,
        seeds = [b"payout-vault", config.protocol_id.as_ref(), args.public_inputs[5].as_ref()], bump,
        token::mint = mint, token::authority = payout)]
    pub payout_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"fees"], bump, token::mint = mint,
        constraint = fee_vault.owner == settings.treasury @ PathnodError::Unauthorized)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_initialize_verifier(ctx: Context<InitializeObservationVerifier>) -> Result<()> {
    ctx.accounts
        .verifier_info
        .set_inner(ObservationVerifierInfo {
            key_digest: trusted_vk::KEY_DIGEST,
            abi_version: 2,
            public_inputs: 7,
        });
    Ok(())
}

pub fn id_field(id: &[u8; 32], domain: u8) -> Result<[u8; 32]> {
    let mut tag = [0; 32];
    tag[31] = domain;
    let mut high = [0; 32];
    high[16..].copy_from_slice(&id[..16]);
    let mut low = [0; 32];
    low[16..].copy_from_slice(&id[16..]);
    poseidon(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&tag, &high, &low],
    )
    .map(|hash| hash.to_bytes())
    .map_err(|_| error!(PathnodError::ObservationBindingMismatch))
}

fn check_authorization(
    instructions: &AccountInfo,
    verifier: &Pubkey,
    digest: &[u8; 32],
) -> Result<()> {
    check_ed25519_authorization(
        instructions,
        verifier,
        digest,
        crate::instruction::SubmitObservation::DISCRIMINATOR,
    )
}

pub(crate) fn check_ed25519_authorization(
    instructions: &AccountInfo,
    verifier: &Pubkey,
    digest: &[u8; 32],
    discriminator: &[u8],
) -> Result<()> {
    let current = load_current_index_checked(instructions)? as usize;
    require!(current > 0, PathnodError::InvalidVerifierAuthorization);
    let consumer = load_instruction_at_checked(current, instructions)?;
    require!(
        consumer.program_id == crate::ID && consumer.data.starts_with(discriminator),
        PathnodError::InvalidVerifierAuthorization
    );
    let previous = load_instruction_at_checked(current - 1, instructions)?;
    let data = previous.data;
    require!(
        previous.program_id == ED25519_PROGRAM && previous.accounts.is_empty() && data.len() == 144,
        PathnodError::InvalidVerifierAuthorization
    );
    let header: [u8; 16] = [
        1, 0, 48, 0, 255, 255, 16, 0, 255, 255, 112, 0, 32, 0, 255, 255,
    ];
    require!(
        data[..16] == header && data[16..48] == verifier.to_bytes() && data[112..144] == *digest,
        PathnodError::InvalidVerifierAuthorization
    );
    Ok(())
}

pub fn append_observation(state: &mut DeviceEpoch, transcript: &[u8; 32]) -> Result<()> {
    let count = state.independent_observers;
    require!(count < u16::MAX, PathnodError::ObserverCountOverflow);
    let mut node = hashv(&[b"Pathnod/observation-leaf/v0", transcript]).to_bytes();
    let mut zero = hashv(&[b"Pathnod/observation-empty/v0"]).to_bytes();
    for level in 0..EPOCH_TREE_DEPTH {
        if count & (1u16 << level) == 0 {
            state.frontier[level] = node;
            node = hashv(&[b"Pathnod/observation-node/v0", &node, &zero]).to_bytes();
        } else {
            node = hashv(&[
                b"Pathnod/observation-node/v0",
                &state.frontier[level],
                &node,
            ])
            .to_bytes();
        }
        zero = hashv(&[b"Pathnod/observation-node/v0", &zero, &zero]).to_bytes();
    }
    state.observation_root = node;
    state.independent_observers = count + 1;
    Ok(())
}

pub fn handle_submit(ctx: Context<SubmitObservation>, args: SubmitObservationArgs) -> Result<()> {
    require!(
        ctx.accounts.commitment.class == 0,
        PathnodError::NullifierAlreadyUsed
    );
    require!(
        args.public_inputs
            .iter()
            .all(|value| *value < FIELD_MODULUS_BE),
        PathnodError::InvalidProof
    );
    require!(
        args.public_inputs[3][..28] == [0; 28] && args.public_inputs[6][..31] == [0; 31],
        PathnodError::ObservationBindingMismatch
    );
    let class = args.public_inputs[6][31];
    require!((1..=3).contains(&class), PathnodError::InvalidPolicy);
    require!(
        ctx.accounts.device.curve == 1
            && ctx.accounts.device.device_id
                == crate::registry::derive_device_id(&ctx.accounts.device.k_dev),
        PathnodError::InvalidDevice
    );
    require!(
        args.public_inputs[1] == id_field(&ctx.accounts.config.protocol_id, 3)?
            && args.public_inputs[2] == id_field(&ctx.accounts.device.device_id, 4)?,
        PathnodError::ObservationBindingMismatch
    );
    let root = &ctx.accounts.observer_root;
    let enrollment = &ctx.accounts.enrollment;
    let active = enrollment.publications.min(4) as usize;
    require!(
        root.root == args.public_inputs[0]
            && root.published_at > 0
            && root.leaf_count > 0
            && root.enrollment_authority == enrollment.authority
            && (0..active).any(|i| {
                enrollment.recent_roots[((enrollment.publications - 1 - i as u64) % 4) as usize]
                    == root.root
            }),
        PathnodError::InvalidRoot
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        now > 0 && ctx.accounts.config.epoch_seconds > 0,
        PathnodError::InvalidObservationEpoch
    );
    let seconds = u64::from(ctx.accounts.config.epoch_seconds);
    let epoch = u64::from(args.epoch());
    require!(
        epoch >= (now as u64).saturating_sub(600) / seconds
            && epoch <= (now as u64).saturating_add(600) / seconds,
        PathnodError::InvalidObservationEpoch
    );
    let digest = observation_authorization_with_evidence_digest(
        &args.transcript_hash,
        &args.evidence_hash,
        &args.public_inputs[4],
        &args.public_inputs[5],
        class,
        ctx.accounts.config.policy_version,
    )?;
    check_authorization(
        &ctx.accounts.instructions.to_account_info(),
        &ctx.accounts.config.verifier_pubkey,
        &digest,
    )?;
    let mut proof = Groth16Verifier::new(
        &args.proof_a,
        &args.proof_b,
        &args.proof_c,
        &args.public_inputs,
        &trusted_vk::KEY,
    )
    .map_err(|_| error!(PathnodError::InvalidProof))?;
    proof
        .verify()
        .map_err(|_| error!(PathnodError::InvalidProof))?;
    append_observation(&mut ctx.accounts.device_epoch, &args.transcript_hash)?;
    let payout = &mut ctx.accounts.payout;
    if payout.mint == Pubkey::default() {
        payout.protocol_id = ctx.accounts.config.protocol_id;
        payout.pseudonym = args.public_inputs[5];
        payout.mint = ctx.accounts.mint.key();
    }
    require!(
        payout.protocol_id == ctx.accounts.config.protocol_id
            && payout.pseudonym == args.public_inputs[5]
            && payout.mint == ctx.accounts.mint.key(),
        PathnodError::InvalidPayout
    );
    let gross = ctx.accounts.config.reward_per_slot;
    let paid = gross > 0
        && ctx.accounts.device_epoch.paid_slots_used < ctx.accounts.config.slots_per_epoch
        && ctx.accounts.escrow.amount >= gross;
    if paid {
        let (fee, net) = crate::payments::split_reward(gross, ctx.accounts.settings.fee_bps)?;
        let protocol = ctx.accounts.config.protocol_id;
        let bump = [ctx.bumps.config];
        let seeds: &[&[u8]] = &[b"protocol", &protocol, &bump];
        for (amount, to) in [
            (net, ctx.accounts.payout_vault.to_account_info()),
            (fee, ctx.accounts.fee_vault.to_account_info()),
        ] {
            if amount > 0 {
                token::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        TransferChecked {
                            from: ctx.accounts.escrow.to_account_info(),
                            to,
                            mint: ctx.accounts.mint.to_account_info(),
                            authority: ctx.accounts.config.to_account_info(),
                        },
                        &[seeds],
                    ),
                    amount,
                    6,
                )?;
            }
        }
        payout.gross = payout
            .gross
            .checked_add(gross)
            .ok_or(PathnodError::PaymentOverflow)?;
        payout.fees = payout
            .fees
            .checked_add(fee)
            .ok_or(PathnodError::PaymentOverflow)?;
        payout.available = payout
            .available
            .checked_add(net)
            .ok_or(PathnodError::PaymentOverflow)?;
        ctx.accounts.device_epoch.paid_slots_used = ctx
            .accounts
            .device_epoch
            .paid_slots_used
            .checked_add(1)
            .ok_or(PathnodError::PaymentOverflow)?;
    }
    ctx.accounts.commitment.set_inner(ObservationCommitment {
        protocol_id: ctx.accounts.config.protocol_id,
        device_id: ctx.accounts.device.device_id,
        epoch: args.epoch(),
        nullifier: args.public_inputs[4],
        pseudonym: args.public_inputs[5],
        class,
        transcript_hash: args.transcript_hash,
        evidence_hash: args.evidence_hash,
        slot_paid: paid,
        submitted_at: now,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::instruction::BorrowedInstruction;
    use serde_json::Value;
    use solana_instructions_sysvar::{construct_instructions_data, store_current_index_checked};
    fn bytes<const N: usize>(value: &str) -> [u8; N] {
        value
            .trim_start_matches("0x")
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect::<Vec<_>>()
            .try_into()
            .unwrap()
    }
    #[test]
    fn verifier_introspection_binds_message_key_layout_and_top_level_consumer() {
        let verifier = Pubkey::new_unique();
        let digest = [17; 32];
        let mut ed = vec![0; 144];
        ed[..16].copy_from_slice(&[
            1, 0, 48, 0, 255, 255, 16, 0, 255, 255, 112, 0, 32, 0, 255, 255,
        ]);
        ed[16..48].copy_from_slice(verifier.as_ref());
        ed[112..].copy_from_slice(&digest);
        let run = |ed: &[u8], ed_program: &Pubkey, consumer: &Pubkey, sysvar: &Pubkey| {
            let instructions = [
                BorrowedInstruction {
                    program_id: ed_program,
                    accounts: vec![],
                    data: ed,
                },
                BorrowedInstruction {
                    program_id: consumer,
                    accounts: vec![],
                    data: crate::instruction::SubmitObservation::DISCRIMINATOR,
                },
            ];
            let mut data = construct_instructions_data(&instructions);
            let mut lamports = 0;
            let owner = Pubkey::default();
            store_current_index_checked(&mut data, 1).unwrap();
            let account = AccountInfo::new(
                sysvar,
                false,
                false,
                &mut lamports,
                &mut data,
                &owner,
                false,
            );
            check_authorization(&account, &verifier, &digest)
        };
        assert!(run(
            &ed,
            &ED25519_PROGRAM,
            &crate::ID,
            &solana_instructions_sysvar::ID
        )
        .is_ok());
        for offset in [0, 2, 4, 6, 8, 10, 12, 14, 16, 112] {
            let mut bad = ed.clone();
            bad[offset] ^= 1;
            assert!(run(
                &bad,
                &ED25519_PROGRAM,
                &crate::ID,
                &solana_instructions_sysvar::ID
            )
            .is_err());
        }
        assert!(run(
            &ed,
            &Pubkey::default(),
            &crate::ID,
            &solana_instructions_sysvar::ID
        )
        .is_err());
        assert!(run(
            &ed,
            &ED25519_PROGRAM,
            &Pubkey::default(),
            &solana_instructions_sysvar::ID
        )
        .is_err());
        assert!(run(&ed, &ED25519_PROGRAM, &crate::ID, &Pubkey::default()).is_err());
    }
    #[test]
    fn shared_ids_use_the_native_poseidon_parameters() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../fixtures/ids/bn254-id-field-v1.json"))
                .unwrap();
        for vector in fixture["vectors"].as_array().unwrap() {
            assert_eq!(
                id_field(
                    &bytes(vector["rawIdHex"].as_str().unwrap()),
                    vector["domain"].as_str().unwrap().parse().unwrap()
                )
                .unwrap(),
                bytes(vector["expectedHex"].as_str().unwrap())
            );
        }
    }
    #[test]
    fn incremental_frontier_matches_independent_full_tree() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../fixtures/observations/dev35-tree.json"
        ))
        .unwrap();
        let mut state = DeviceEpoch {
            independent_observers: 0,
            paid_slots_used: 0,
            observation_root: [0; 32],
            confidence_commitment: [0; 32],
            frontier: [[0; 32]; 16],
        };
        for (i, transcript) in fixture["transcriptHashes"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            append_observation(&mut state, &bytes(transcript.as_str().unwrap())).unwrap();
            assert_eq!(
                state.observation_root,
                bytes(fixture["roots"][i].as_str().unwrap())
            );
            assert_eq!(state.independent_observers, (i + 1) as u16);
        }
        state.independent_observers = u16::MAX;
        let previous = state.observation_root;
        assert!(append_observation(&mut state, &[0; 32]).is_err());
        assert_eq!(state.observation_root, previous);
        assert_eq!(DeviceEpoch::INIT_SPACE + 8, 587);
        assert_eq!(ObservationCommitment::INIT_SPACE + 8, 214);
    }
    #[test]
    fn both_real_mopro_proofs_verify_with_the_compiled_trust_anchor() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../fixtures/observations/dev35-proofs.json"
        ))
        .unwrap();
        for vector in fixture["vectors"].as_array().unwrap() {
            let packed: [u8; 480] = bytes(vector["proofBytes"].as_str().unwrap());
            let a: [u8; 64] = packed[..64].try_into().unwrap();
            let b: [u8; 128] = packed[64..192].try_into().unwrap();
            let c: [u8; 64] = packed[192..256].try_into().unwrap();
            let public: [[u8; 32]; 7] =
                std::array::from_fn(|i| packed[256 + i * 32..288 + i * 32].try_into().unwrap());
            assert!(Groth16Verifier::new(&a, &b, &c, &public, &trusted_vk::KEY)
                .unwrap()
                .verify()
                .is_ok());
            let bad = [0; 64];
            assert!(
                Groth16Verifier::new(&a, &b, &bad, &public, &trusted_vk::KEY)
                    .unwrap()
                    .verify()
                    .is_err()
            );
        }
        let mut packed = Vec::new();
        packed.extend(trusted_vk::KEY.vk_alpha_g1);
        packed.extend(trusted_vk::KEY.vk_beta_g2);
        packed.extend(trusted_vk::KEY.vk_gamme_g2);
        packed.extend(trusted_vk::KEY.vk_delta_g2);
        for point in trusted_vk::KEY.vk_ic {
            packed.extend(point);
        }
        assert_eq!(
            hashv(&[b"Pathnod/groth16-key/v0", &packed]).to_bytes(),
            trusted_vk::KEY_DIGEST
        );
    }
}
