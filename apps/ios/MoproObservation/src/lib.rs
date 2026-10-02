mod error;
pub use error::MoproError;

mopro_ffi::app!();

mod circom;
pub use circom::{
    generate_circom_proof, verify_circom_proof, CircomProof, CircomProofResult, ProofLib, G1, G2,
};

mod witness {
    rust_witness::witness!(observation);
}

crate::set_circom_circuits! {
    ("observation_final.zkey", circom_prover::witness::WitnessFn::RustWitness(witness::observation_witness)),
}
