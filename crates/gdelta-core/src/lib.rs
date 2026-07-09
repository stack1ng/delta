//! GDelta structural binary delta.
//!
//! Ported from the MIT-licensed `gdelta` crate by Oliver Seifert
//! (<https://github.com/ImGajeed76/gdelta>), which implements the GDelta
//! algorithm by Haoliang Tan et al. First-party additions: an incremental
//! [`StreamDecoder`] and string-free error codes suitable for small wasm
//! artifacts. See NOTICE at the repository root.
//!
//! Streaming characteristics (inherent to the algorithm and wire format):
//! - encode needs random access to the full base and the full new data, and
//!   the delta is only known once encode completes (length-prefixed
//!   instruction block);
//! - decode needs random access to the full base, but consumes the delta
//!   sequentially and emits output incrementally.

mod buffer;
mod delta;
mod error;
mod gear;
mod stream;
mod varint;

pub use error::{GDeltaError, Result};
pub use stream::StreamDecoder;

/// Encodes the delta that transforms `base_data` into `new_data`.
pub fn encode(new_data: &[u8], base_data: &[u8]) -> Vec<u8> {
    delta::encode(new_data, base_data)
}

/// Decodes a complete delta against `base_data`, returning the new data.
pub fn decode(delta: &[u8], base_data: &[u8]) -> Result<Vec<u8>> {
    delta::decode(delta, base_data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_various_shapes() {
        let cases: Vec<(Vec<u8>, Vec<u8>)> = vec![
            (b"Hello, World!".to_vec(), b"Hello, Rust!".to_vec()),
            (Vec::new(), b"something".to_vec()),
            (b"something".to_vec(), Vec::new()),
            (Vec::new(), Vec::new()),
            (vec![7u8; 5000], vec![7u8; 5001]),
        ];

        for (base, new) in cases {
            let delta = encode(&new, &base);
            assert_eq!(decode(&delta, &base).unwrap(), new);
        }
    }
}
