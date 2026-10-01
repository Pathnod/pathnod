use std::{fs, path::PathBuf};

use pathnod_observation_mopro::{generate_circom_proof, verify_circom_proof, ProofLib};

#[test]
#[ignore = "requires LocalCircuits prepared from DEV-13"]
fn synthetic_observation_proves_and_verifies() {
    let artifacts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("LocalCircuits");
    let zkey = artifacts.join("observation_final.zkey");
    let input = fs::read_to_string(artifacts.join("mopro-input.json")).expect("Mopro input JSON");
    let expected: Vec<String> = serde_json::from_str(
        &fs::read_to_string(artifacts.join("public.json")).expect("public inputs JSON"),
    )
    .expect("public inputs array");

    let zkey_path = zkey.to_str().expect("UTF-8 path").to_string();
    let proof = generate_circom_proof(zkey_path.clone(), input, ProofLib::Arkworks)
        .expect("generate Mopro proof");
    assert_eq!(proof.inputs, expected);
    assert!(verify_circom_proof(zkey_path, proof, ProofLib::Arkworks).expect("verify Mopro proof"));
}
