use pathnod_observation_mopro::{generate_circom_proof, verify_circom_proof, ProofLib};
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf};

#[test]
#[ignore = "requires local development proving artifacts and explicit output paths"]
fn generate_dev35_public_fixtures() {
    let input=env::var("PATHNOD_DEV35_WITNESSES").expect("public synthetic input path");
    let output=env::var("PATHNOD_DEV35_PROOFS").expect("output path outside Git");
    let data:Value=serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
    assert_eq!(data["publicTestVectors"],true);
    let project=PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let key=project.join("LocalCircuits/observation_final.zkey").to_str().unwrap().to_owned();
    let mut vectors=Vec::new();
    for vector in data["vectors"].as_array().unwrap() {
        let result=generate_circom_proof(key.clone(),vector["inputs"].to_string(),ProofLib::Arkworks).unwrap();
        assert_eq!(serde_json::to_value(&result.inputs).unwrap(),vector["public"]);
        assert!(verify_circom_proof(key.clone(),result.clone(),ProofLib::Arkworks).unwrap());
        vectors.push(json!({"secret":vector["secret"],"commitment":vector["commitment"],"public":result.inputs,
            "proof":{"pi_a":[result.proof.a.x,result.proof.a.y,result.proof.a.z],
            "pi_b":[result.proof.b.x,result.proof.b.y,result.proof.b.z],"pi_c":[result.proof.c.x,result.proof.c.y,result.proof.c.z],
            "protocol":"groth16","curve":"bn128"}}));
    }
    fs::write(output,serde_json::to_string_pretty(&json!({"publicTestVectors":true,"vectors":vectors})).unwrap()+"\n").unwrap();
}
