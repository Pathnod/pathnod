//! Pathnod on-chain program.
//!
//! This is the toolchain baseline from DEV-01/DEV-02. It holds no state and
//! implements none of the protocol: the registry, proof verification, escrow,
//! nullifier and payment logic all land in later roadmap tasks.

use anchor_lang::prelude::*;

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
}

#[derive(Accounts)]
pub struct Initialize {}
