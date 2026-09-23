use std::{collections::HashSet, fs, path::PathBuf};

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

fn validate_fixture_vectors(vectors: &[Vector]) -> Result<(), String> {
    let mut names = HashSet::new();
    let mut covered_arities = HashSet::new();

    for vector in vectors {
        let safe_name = !vector.name.is_empty()
            && vector.name.len() <= 100
            && vector.name.split('-').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            });
        if !safe_name {
            return Err(format!("unsafe Poseidon vector name: {}", vector.name));
        }
        if !names.insert(vector.name.as_str()) {
            return Err(format!("duplicate Poseidon vector name: {}", vector.name));
        }
        if !matches!(vector.arity, 1 | 2 | 3 | 5) {
            return Err(format!("unsupported Poseidon arity: {}", vector.arity));
        }
        if vector.inputs.len() != vector.arity {
            return Err(format!("{}: input count does not match arity", vector.name));
        }
        covered_arities.insert(vector.arity);
    }

    for arity in [1, 2, 3, 5] {
        if !covered_arities.contains(&arity) {
            return Err(format!(
                "Poseidon fixture is missing arity {arity} coverage"
            ));
        }
    }
    Ok(())
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
    validate_fixture_vectors(&fixture.vectors).expect("validate fixture vectors");
    fixture
}

#[test]
fn rejects_missing_arities_and_duplicate_or_unsafe_names() {
    for arity in [1, 2, 3, 5] {
        let mut missing = fixture();
        missing.vectors.retain(|vector| vector.arity != arity);
        assert_eq!(
            validate_fixture_vectors(&missing.vectors),
            Err(format!(
                "Poseidon fixture is missing arity {arity} coverage"
            ))
        );
    }

    let mut duplicate = fixture();
    let duplicate_name = duplicate.vectors[0].name.clone();
    duplicate.vectors[1].name = duplicate_name;
    assert!(validate_fixture_vectors(&duplicate.vectors).is_err());

    let mut unsafe_name = fixture();
    unsafe_name.vectors[0].name = "../harmless-review-marker".to_owned();
    assert!(validate_fixture_vectors(&unsafe_name.vectors).is_err());
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
    assert_eq!(
        parse_canonical_field_bytes(&"9".repeat(100_000)),
        Err(AdapterError::NonCanonicalFieldElement)
    );
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
