use num_bigint::BigUint;
use pathnod_observation_mopro::{generate_circom_proof, verify_circom_proof, ProofLib};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

fn decimal(value: &str) -> String {
    BigUint::parse_bytes(value.trim_start_matches("0x").as_bytes(), 16)
        .expect("fixture hex")
        .to_string()
}

#[test]
#[ignore = "requires DEV-13 LocalCircuits; generates real proofs for DEV-31 captures"]
fn captured_observation_witnesses_prove_and_verify() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixtures: Value = serde_json::from_slice(
        &fs::read(project.join("../../../fixtures/observations/transcript-v0.json")).unwrap(),
    )
    .unwrap();
    let zkey = project
        .join("LocalCircuits/observation_final.zkey")
        .to_str()
        .unwrap()
        .to_owned();
    for v in fixtures["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["capture"].is_object())
    {
        let t = &v["transcript"];
        let path = &v["enrollment"];
        let epoch = t["epoch"].as_u64().unwrap().to_string();
        let class = t["observerClass"].as_u64().unwrap().to_string();
        let public = vec![
            decimal(path["root"].as_str().unwrap()),
            decimal(v["protocolField"].as_str().unwrap()),
            decimal(v["deviceField"].as_str().unwrap()),
            epoch.clone(),
            decimal(t["nullifier"].as_str().unwrap()),
            decimal(t["pseudonym"].as_str().unwrap()),
            class.clone(),
        ];
        let witness = json!({
            "s_obs": [decimal(v["secret"].as_str().unwrap())], "class": [class],
            "merkle_path": path["siblings"].as_array().unwrap().iter().map(|v| decimal(v.as_str().unwrap())).collect::<Vec<_>>(),
            "merkle_index": path["directions"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap().to_string()).collect::<Vec<_>>(),
            "root": [public[0]], "protocol_id_f": [public[1]], "device_id_f": [public[2]], "epoch": [public[3]],
            "nullifier": [public[4]], "pseudonym": [public[5]], "class_pub": [public[6]]
        });
        let result = generate_circom_proof(zkey.clone(), witness.to_string(), ProofLib::Arkworks)
            .expect("real DEV-32 proof");
        assert_eq!(result.inputs, public);
        assert!(verify_circom_proof(zkey.clone(), result.clone(), ProofLib::Arkworks).unwrap());
        if v["name"] == "absent-signals" {
            if let Some(destination) = std::env::var_os("PATHNOD_DEV32_MOPRO_PROOF") {
                fs::write(destination, json!({"proof": {"pi_a": [result.proof.a.x, result.proof.a.y, result.proof.a.z],
                    "pi_b": [result.proof.b.x, result.proof.b.y, result.proof.b.z],
                    "pi_c": [result.proof.c.x, result.proof.c.y, result.proof.c.z], "protocol": "groth16", "curve": "bn128"},
                    "public": result.inputs}).to_string()).unwrap();
            }
        }
    }
}
