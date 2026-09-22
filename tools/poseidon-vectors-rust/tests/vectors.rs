use std::{fs, path::PathBuf};

use pathnod_poseidon_vectors::{
    decimal_from_bytes, hash_canonical_inputs, hex_from_bytes, parse_canonical_field_bytes,
    AdapterError, FIELD_MODULUS,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: u32,
    algorithm: String,
    parameter_set: String,
    field_modulus: String,
    input_encoding: String,
    output_encoding: String,
    diagnostic_hex_encoding: String,
    public_test_data: bool,
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    name: String,
    arity: usize,
    inputs: Vec<String>,
    expected: String,
    expected_hex: String,
}

fn fixture() -> Fixture {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/poseidon/bn254-circom-v1.json");
    let fixture: Fixture = serde_json::from_str(&fs::read_to_string(path).expect("read fixture"))
        .expect("parse fixture");
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.algorithm, "poseidon");
    assert_eq!(fixture.parameter_set, "circom-bn254-x5");
    assert_eq!(fixture.field_modulus, FIELD_MODULUS);
    assert_eq!(fixture.input_encoding, "unsigned-base10-field-element");
    assert_eq!(fixture.output_encoding, "unsigned-base10-field-element");
    assert_eq!(fixture.diagnostic_hex_encoding, "32-byte-big-endian");
    assert!(fixture.public_test_data);
    fixture
}

#[test]
fn rust_matches_every_canonical_vector() {
    for vector in fixture().vectors {
        let (bytes, _field) = hash_canonical_inputs(&vector.inputs, vector.arity)
            .unwrap_or_else(|error| panic!("{}: {error}", vector.name));
        assert_eq!(
            decimal_from_bytes(&bytes),
            vector.expected,
            "{}",
            vector.name
        );
        assert_eq!(
            hex_from_bytes(&bytes),
            vector.expected_hex,
            "{}",
            vector.name
        );
    }
}

#[test]
fn rejects_non_canonical_and_malformed_values() {
    for value in ["-1", FIELD_MODULUS, "01", "1.0", "nope", ""] {
        assert!(
            parse_canonical_field_bytes(value).is_err(),
            "accepted {value:?}"
        );
    }
}

#[test]
fn rejects_missing_and_unsupported_arities() {
    assert_eq!(
        hash_canonical_inputs(&["1".to_owned()], 2),
        Err(AdapterError::WrongArity {
            declared: 2,
            actual: 1,
        })
    );
    assert_eq!(
        hash_canonical_inputs(&vec!["1".to_owned(); 4], 4),
        Err(AdapterError::UnsupportedArity(4))
    );
}

#[test]
fn reordered_inputs_do_not_match_the_canonical_smoke_vector() {
    let fixture = fixture();
    let smoke = fixture
        .vectors
        .iter()
        .find(|vector| vector.name == "arity-2-endianness-smoke")
        .expect("smoke vector");
    let mut reordered = smoke.inputs.clone();
    reordered.reverse();
    let (bytes, _) = hash_canonical_inputs(&reordered, smoke.arity).expect("hash reordered inputs");
    assert_ne!(decimal_from_bytes(&bytes), smoke.expected);
}
