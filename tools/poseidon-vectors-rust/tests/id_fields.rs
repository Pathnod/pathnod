use std::{collections::HashSet, fs, path::PathBuf};

use pathnod_poseidon_vectors::{
    decimal_from_bytes, derive_device_id_field, derive_protocol_id_field, hex_from_bytes,
    DOMAIN_DEVICE_ID, DOMAIN_PROTOCOL_ID,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: u32,
    algorithm: String,
    parameter_set: String,
    raw_id_encoding: String,
    limb_encoding: String,
    output_encoding: String,
    public_test_data: bool,
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    name: String,
    kind: String,
    raw_id_hex: String,
    domain: String,
    high128: String,
    low128: String,
    expected: String,
    expected_hex: String,
}

fn decode_id(hex: &str) -> [u8; 32] {
    assert_eq!(hex.len(), 66);
    assert!(hex.starts_with("0x"));
    let mut id = [0_u8; 32];
    for (index, byte) in id.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2 + index * 2..4 + index * 2], 16).expect("hex byte");
    }
    id
}

#[test]
fn rust_matches_shared_id_vectors() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/ids/bn254-id-field-v1.json");
    let fixture: Fixture = serde_json::from_str(&fs::read_to_string(path).expect("read fixture"))
        .expect("parse fixture");
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.algorithm, "poseidon");
    assert_eq!(fixture.parameter_set, "circom-bn254-x5");
    assert_eq!(fixture.raw_id_encoding, "32-byte-big-endian");
    assert_eq!(fixture.limb_encoding, "two-unsigned-128-bit-big-endian");
    assert_eq!(
        fixture.output_encoding,
        "canonical-bn254-32-byte-big-endian"
    );
    assert!(fixture.public_test_data);
    assert_eq!(fixture.vectors.len(), 4);

    let mut names = HashSet::new();
    for vector in fixture.vectors {
        assert!(!vector.name.is_empty());
        assert!(names.insert(vector.name.clone()));
        let id = decode_id(&vector.raw_id_hex);
        assert_eq!(
            num_bigint::BigUint::from_bytes_be(&id[..16]).to_str_radix(10),
            vector.high128
        );
        assert_eq!(
            num_bigint::BigUint::from_bytes_be(&id[16..]).to_str_radix(10),
            vector.low128
        );
        let result = match vector.kind.as_str() {
            "protocol" => {
                assert_eq!(vector.domain, DOMAIN_PROTOCOL_ID.to_string());
                derive_protocol_id_field(&id)
            }
            "device" => {
                assert_eq!(vector.domain, DOMAIN_DEVICE_ID.to_string());
                derive_device_id_field(&id)
            }
            _ => panic!("unexpected ID kind"),
        }
        .expect("hash ID");
        assert_eq!(
            decimal_from_bytes(&result),
            vector.expected,
            "{}",
            vector.name
        );
        assert_eq!(
            hex_from_bytes(&result),
            vector.expected_hex,
            "{}",
            vector.name
        );
    }
}

#[test]
fn domains_separate_identical_ids() {
    let id = [0_u8; 32];
    assert_ne!(
        derive_protocol_id_field(&id).expect("protocol"),
        derive_device_id_field(&id).expect("device")
    );
}
