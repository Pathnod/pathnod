use std::{error::Error, fmt};

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use light_poseidon::{Poseidon, PoseidonBytesHasher, PoseidonHasher};
use num_bigint::BigUint;

pub const FIELD_MODULUS: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";

#[derive(Debug, PartialEq, Eq)]
pub enum AdapterError {
    InvalidDecimal,
    NonCanonicalFieldElement,
    UnsupportedArity(usize),
    WrongArity { declared: usize, actual: usize },
    Poseidon(String),
}

impl fmt::Display for AdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDecimal => write!(formatter, "invalid unsigned base-10 field element"),
            Self::NonCanonicalFieldElement => {
                write!(formatter, "non-canonical BN254 field element")
            }
            Self::UnsupportedArity(arity) => {
                write!(formatter, "unsupported Poseidon arity: {arity}")
            }
            Self::WrongArity { declared, actual } => {
                write!(
                    formatter,
                    "declared arity {declared} does not match {actual} inputs"
                )
            }
            Self::Poseidon(message) => write!(formatter, "Poseidon error: {message}"),
        }
    }
}

impl Error for AdapterError {}

pub fn parse_canonical_field_bytes(value: &str) -> Result<[u8; 32], AdapterError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AdapterError::InvalidDecimal);
    }

    let value = BigUint::parse_bytes(value.as_bytes(), 10).ok_or(AdapterError::InvalidDecimal)?;
    let modulus = BigUint::parse_bytes(FIELD_MODULUS.as_bytes(), 10).expect("valid field modulus");
    if value >= modulus {
        return Err(AdapterError::NonCanonicalFieldElement);
    }

    let encoded = value.to_bytes_be();
    let mut bytes = [0_u8; 32];
    bytes[32 - encoded.len()..].copy_from_slice(&encoded);
    Ok(bytes)
}

pub fn hash_canonical_inputs(
    values: &[String],
    declared_arity: usize,
) -> Result<([u8; 32], Fr), AdapterError> {
    if !matches!(declared_arity, 1 | 2 | 3 | 5) {
        return Err(AdapterError::UnsupportedArity(declared_arity));
    }
    if values.len() != declared_arity {
        return Err(AdapterError::WrongArity {
            declared: declared_arity,
            actual: values.len(),
        });
    }

    let encoded = values
        .iter()
        .map(|value| parse_canonical_field_bytes(value))
        .collect::<Result<Vec<_>, _>>()?;
    let references = encoded.iter().map(<[u8; 32]>::as_slice).collect::<Vec<_>>();

    let mut bytes_hasher = Poseidon::<Fr>::new_circom(declared_arity)
        .map_err(|error| AdapterError::Poseidon(error.to_string()))?;
    let bytes = bytes_hasher
        .hash_bytes_be(&references)
        .map_err(|error| AdapterError::Poseidon(error.to_string()))?;

    let inputs = encoded
        .iter()
        .map(|bytes| Fr::from_be_bytes_mod_order(bytes))
        .collect::<Vec<_>>();
    let mut field_hasher = Poseidon::<Fr>::new_circom(declared_arity)
        .map_err(|error| AdapterError::Poseidon(error.to_string()))?;
    let field = field_hasher
        .hash(&inputs)
        .map_err(|error| AdapterError::Poseidon(error.to_string()))?;

    let field_bytes = field.into_bigint().to_bytes_be();
    let mut padded_field_bytes = [0_u8; 32];
    padded_field_bytes[32 - field_bytes.len()..].copy_from_slice(&field_bytes);
    if bytes != padded_field_bytes {
        return Err(AdapterError::Poseidon(
            "byte and field output representations differ".to_owned(),
        ));
    }

    Ok((bytes, field))
}

pub fn decimal_from_bytes(bytes: &[u8; 32]) -> String {
    BigUint::from_bytes_be(bytes).to_str_radix(10)
}

pub fn hex_from_bytes(bytes: &[u8; 32]) -> String {
    let mut encoded = String::with_capacity(66);
    encoded.push_str("0x");
    for byte in bytes {
        use fmt::Write;
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}
