use crate::{PathnodError, RegisterDeviceArgs};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use solana_sha256_hasher::hashv;

pub const BUBBLEGUM_V1: Pubkey = pubkey!("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");
pub const ACCOUNT_COMPRESSION_V1: Pubkey = pubkey!("cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK");
pub const CONTROL_PROOF_SIZE: usize = 213;
const TREE_CONFIG_DISCRIMINATOR: [u8; 8] = [122, 245, 175, 248, 171, 34, 0, 207];

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CnftControlProof {
    pub tree: Pubkey,
    pub owner: Pubkey,
    pub delegate: Pubkey,
    pub nonce: u64,
    pub index: u32,
    pub root: [u8; 32],
    pub data_hash: [u8; 32],
    pub creator_hash: [u8; 32],
    pub expires_at: i64,
}

impl CnftControlProof {
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        require!(
            bytes.len() == CONTROL_PROOF_SIZE && bytes[0] == 1,
            PathnodError::UnsupportedControlProof
        );
        Self::try_from_slice(&bytes[1..]).map_err(|_| error!(PathnodError::UnsupportedControlProof))
    }
    pub fn asset_id(&self) -> Pubkey {
        Pubkey::find_program_address(
            &[b"asset", self.tree.as_ref(), &self.nonce.to_le_bytes()],
            &BUBBLEGUM_V1,
        )
        .0
    }
    pub fn leaf(&self) -> [u8; 32] {
        solana_keccak_hasher::hashv(&[
            &[1],
            self.asset_id().as_ref(),
            self.owner.as_ref(),
            self.delegate.as_ref(),
            &self.nonce.to_le_bytes(),
            &self.data_hash,
            &self.creator_hash,
        ])
        .to_bytes()
    }
}

pub fn control_authorization_digest(
    program: &Pubkey,
    requester: &Pubkey,
    protocol: &[u8; 32],
    args: &RegisterDeviceArgs,
) -> Result<[u8; 32]> {
    let bytes = args
        .proof_of_control
        .as_deref()
        .ok_or(error!(PathnodError::UnsupportedControlProof))?;
    let proof = CnftControlProof::decode(bytes)?;
    let asset = args
        .external_asset
        .ok_or(error!(PathnodError::InvalidExternalAssetProof))?;
    require_keys_eq!(
        asset,
        proof.asset_id(),
        PathnodError::InvalidExternalAssetProof
    );
    let geo = match args.claimed_geohash6 {
        Some(value) => [&[1u8][..], &value].concat(),
        None => vec![0],
    };
    Ok(hashv(&[
        b"Pathnod/asset-control/v0",
        program.as_ref(),
        requester.as_ref(),
        protocol,
        &args.device_id,
        &args.k_dev,
        &[args.curve],
        asset.as_ref(),
        &args.capabilities.to_le_bytes(),
        &geo,
        bytes,
    ])
    .to_bytes())
}

pub fn verify_control<'info>(
    requester: &Pubkey,
    protocol: &[u8; 32],
    args: &RegisterDeviceArgs,
    remaining: &[AccountInfo<'info>],
    now: i64,
) -> Result<()> {
    let bytes = args
        .proof_of_control
        .as_deref()
        .ok_or(error!(PathnodError::UnsupportedControlProof))?;
    let proof = CnftControlProof::decode(bytes)?;
    require!(
        remaining.len() >= 4 && remaining.len() <= 34,
        PathnodError::InvalidExternalAssetProof
    );
    require!(
        now >= 0 && proof.expires_at > now && proof.expires_at.saturating_sub(now) <= 600,
        PathnodError::ExpiredAssetControlProof
    );
    require_keys_neq!(
        proof.owner,
        Pubkey::default(),
        PathnodError::InvalidExternalAssetProof
    );
    let [instructions, tree, config, compression] =
        [&remaining[0], &remaining[1], &remaining[2], &remaining[3]];
    require_keys_eq!(
        *instructions.key,
        solana_instructions_sysvar::ID,
        PathnodError::InvalidExternalAssetProof
    );
    require_keys_eq!(
        *tree.key,
        proof.tree,
        PathnodError::InvalidExternalAssetProof
    );
    require_keys_eq!(
        *tree.owner,
        ACCOUNT_COMPRESSION_V1,
        PathnodError::InvalidExternalAssetProof
    );
    require_keys_eq!(
        *compression.key,
        ACCOUNT_COMPRESSION_V1,
        PathnodError::InvalidExternalAssetProof
    );
    require!(
        compression.executable && !tree.executable && !config.executable,
        PathnodError::InvalidExternalAssetProof
    );
    let expected_config = Pubkey::find_program_address(&[proof.tree.as_ref()], &BUBBLEGUM_V1).0;
    require_keys_eq!(
        *config.key,
        expected_config,
        PathnodError::InvalidExternalAssetProof
    );
    require_keys_eq!(
        *config.owner,
        BUBBLEGUM_V1,
        PathnodError::InvalidExternalAssetProof
    );
    {
        let header = tree.try_borrow_data()?;
        require!(
            header.len() >= 56
                && header[..2] == [1, 0]
                && header[10..42] == expected_config.to_bytes(),
            PathnodError::InvalidExternalAssetProof
        );
        let depth = u32::from_le_bytes(header[6..10].try_into().unwrap());
        require!(
            (3..=30).contains(&depth)
                && proof.index < (1u32 << depth)
                && remaining.len() - 4 <= depth as usize,
            PathnodError::InvalidExternalAssetProof
        );
        let data = config.try_borrow_data()?;
        require!(
            data.len() == 96
                && data[..8] == TREE_CONFIG_DISCRIMINATOR
                && data[90] == 0
                && data[88] <= 1
                && data[89] <= 1,
            PathnodError::UnsupportedControlProof
        );
        let capacity = u64::from_le_bytes(data[72..80].try_into().unwrap());
        let minted = u64::from_le_bytes(data[80..88].try_into().unwrap());
        require!(
            capacity == 1u64 << depth && minted <= capacity && proof.nonce < minted,
            PathnodError::InvalidExternalAssetProof
        );
    }
    let digest = control_authorization_digest(&crate::ID, requester, protocol, args)?;
    crate::observation::check_ed25519_authorization(
        instructions,
        &proof.owner,
        &digest,
        crate::instruction::RegisterDevice::DISCRIMINATOR,
    )
    .map_err(|_| error!(PathnodError::InvalidAssetControlAuthorization))?;
    let mut data = hashv(&[b"global:verify_leaf"]).to_bytes()[..8].to_vec();
    data.extend_from_slice(&proof.root);
    data.extend_from_slice(&proof.leaf());
    data.extend_from_slice(&proof.index.to_le_bytes());
    let mut metas = vec![AccountMeta::new_readonly(proof.tree, false)];
    let mut infos = vec![tree.clone(), compression.clone()];
    for node in &remaining[4..] {
        metas.push(AccountMeta::new_readonly(*node.key, false));
        infos.push(node.clone());
    }
    invoke(
        &Instruction {
            program_id: ACCOUNT_COMPRESSION_V1,
            accounts: metas,
            data,
        },
        &infos,
    )
    .map_err(|_| error!(PathnodError::InvalidExternalAssetProof))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn bytes<const N: usize>(text: &str) -> [u8; N] {
        let mut out = [0; N];
        assert_eq!(text.len(), N * 2);
        for (i, value) in out.iter_mut().enumerate() {
            *value = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
    fn fixture() -> (
        Pubkey,
        Pubkey,
        [u8; 32],
        RegisterDeviceArgs,
        serde_json::Value,
    ) {
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/assets/bubblegum-control-v0.json"
        ))
        .unwrap();
        let raw = v["proofBytes"].as_str().unwrap();
        let proof = bytes::<CONTROL_PROOF_SIZE>(raw).to_vec();
        let args = RegisterDeviceArgs {
            device_id: bytes(v["deviceID"].as_str().unwrap()),
            k_dev: bytes(v["deviceKey"].as_str().unwrap()),
            curve: 1,
            external_asset: Some(Pubkey::from_str(v["asset"].as_str().unwrap()).unwrap()),
            proof_of_control: Some(proof),
            capabilities: 42,
            claimed_geohash6: None,
        };
        (
            Pubkey::from_str(v["program"].as_str().unwrap()).unwrap(),
            Pubkey::from_str(v["requester"].as_str().unwrap()).unwrap(),
            bytes(v["protocolID"].as_str().unwrap()),
            args,
            v,
        )
    }
    #[test]
    fn shared_bubblegum_leaf_and_control_authorization_vector() {
        let (program, requester, protocol, args, v) = fixture();
        let proof = CnftControlProof::decode(args.proof_of_control.as_ref().unwrap()).unwrap();
        assert_eq!(proof.asset_id(), args.external_asset.unwrap());
        assert_eq!(proof.leaf(), bytes::<32>(v["leaf"].as_str().unwrap()));
        assert_eq!(
            control_authorization_digest(&program, &requester, &protocol, &args).unwrap(),
            bytes::<32>(v["digest"].as_str().unwrap())
        );
    }
    #[test]
    fn authorization_changes_with_every_registration_scope_and_metadata_field() {
        let (program, requester, protocol, mut args, _) = fixture();
        let original =
            control_authorization_digest(&program, &requester, &protocol, &args).unwrap();
        assert_ne!(
            original,
            control_authorization_digest(&Pubkey::new_unique(), &requester, &protocol, &args)
                .unwrap()
        );
        assert_ne!(
            original,
            control_authorization_digest(&program, &Pubkey::new_unique(), &protocol, &args)
                .unwrap()
        );
        assert_ne!(
            original,
            control_authorization_digest(&program, &requester, &[9; 32], &args).unwrap()
        );
        args.capabilities ^= 1;
        assert_ne!(
            original,
            control_authorization_digest(&program, &requester, &protocol, &args).unwrap()
        );
        args.capabilities ^= 1;
        args.claimed_geohash6 = Some(*b"u09tvw");
        assert_ne!(
            original,
            control_authorization_digest(&program, &requester, &protocol, &args).unwrap()
        );
        args.claimed_geohash6 = None;
        args.k_dev[0] ^= 1;
        assert_ne!(
            original,
            control_authorization_digest(&program, &requester, &protocol, &args).unwrap()
        );
    }
    #[test]
    fn proof_codec_rejects_unknown_versions_truncation_trailing_data_and_wrong_asset() {
        let (program, requester, protocol, mut args, _) = fixture();
        let bytes = args.proof_of_control.as_ref().unwrap();
        for size in 0..bytes.len() {
            assert!(CnftControlProof::decode(&bytes[..size]).is_err());
        }
        let mut altered = bytes.clone();
        altered.push(0);
        assert!(CnftControlProof::decode(&altered).is_err());
        altered = bytes.clone();
        altered[0] = 2;
        assert!(CnftControlProof::decode(&altered).is_err());
        args.external_asset = Some(Pubkey::new_unique());
        assert!(control_authorization_digest(&program, &requester, &protocol, &args).is_err());
    }
}
