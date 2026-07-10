//! Core delta encoding and one-shot decoding.
//!
//! Adapted from the MIT-licensed `gdelta` crate by Oliver Seifert
//! (<https://github.com/ImGajeed76/gdelta>), which implements the GDelta
//! algorithm by Haoliang Tan et al. See NOTICE at the repository root.
//!
//! Delta wire format: `varint(instruction_len) || instructions || literal data`.
//! The instruction-length prefix means the encoder must finish before the
//! first delta byte is known; the delta cannot be emitted incrementally
//! during encode.

use crate::buffer::{BufferStream, INIT_BUFFER_SIZE};
use crate::error::Result;
use crate::gear::{WORD_SIZE, build_hash_table, compute_fingerprint, roll_fingerprint};
use crate::stream::StreamDecoder;
use crate::varint::{DeltaUnit, write_delta_unit, write_varint};

/// Minimum length for prefix/suffix optimization.
const MIN_MATCH_LENGTH: usize = 16;

/// Encodes the delta that transforms `base_data` into `new_data`.
pub fn encode(new_data: &[u8], base_data: &[u8]) -> Vec<u8> {
    let new_size = new_data.len();
    let base_size = base_data.len();

    let prefix_len = find_common_prefix(new_data, base_data);
    let has_prefix = prefix_len >= MIN_MATCH_LENGTH;
    let prefix_size = if has_prefix { prefix_len } else { 0 };

    let suffix_len = find_common_suffix(new_data, base_data, prefix_size);
    let mut suffix_size = if suffix_len >= MIN_MATCH_LENGTH {
        suffix_len
    } else {
        0
    };

    if prefix_size + suffix_size > new_size {
        suffix_size = new_size.saturating_sub(prefix_size);
    }

    let mut instruction_stream = BufferStream::with_capacity(INIT_BUFFER_SIZE);
    let mut data_stream = BufferStream::with_capacity(INIT_BUFFER_SIZE);

    if prefix_size + suffix_size >= base_size {
        encode_trivial_case(
            new_data,
            base_data,
            prefix_size,
            suffix_size,
            &mut instruction_stream,
            &mut data_stream,
        );

        return finalize_delta(&instruction_stream, &data_stream);
    }

    if has_prefix {
        let unit = DeltaUnit::copy(0, prefix_size as u64);
        write_delta_unit(&mut instruction_stream, &unit);
    }

    let work_base_size = base_size - prefix_size - suffix_size;
    let hash_bits = calculate_hash_bits(work_base_size);
    let hash_table = build_hash_table(base_data, prefix_size, base_size - suffix_size, hash_bits);
    let hash_shift = 64 - hash_bits;

    encode_middle_section(
        new_data,
        base_data,
        prefix_size,
        new_size - suffix_size,
        base_size - suffix_size,
        &hash_table[..],
        hash_shift,
        &mut instruction_stream,
        &mut data_stream,
    );

    if suffix_size > 0 {
        let unit = DeltaUnit::copy((base_size - suffix_size) as u64, suffix_size as u64);
        write_delta_unit(&mut instruction_stream, &unit);
    }

    finalize_delta(&instruction_stream, &data_stream)
}

/// Finds the length of the common prefix between two byte slices.
fn find_common_prefix(a: &[u8], b: &[u8]) -> usize {
    let max_len = a.len().min(b.len());
    let mut len = 0;

    while len + 8 <= max_len {
        let a_chunk = u64::from_le_bytes(a[len..len + 8].try_into().unwrap());
        let b_chunk = u64::from_le_bytes(b[len..len + 8].try_into().unwrap());
        if a_chunk != b_chunk {
            break;
        }
        len += 8;
    }

    while len < max_len && a[len] == b[len] {
        len += 1;
    }

    len
}

/// Finds the length of the common suffix between two byte slices.
fn find_common_suffix(a: &[u8], b: &[u8], prefix_len: usize) -> usize {
    let max_len = (a.len() - prefix_len).min(b.len() - prefix_len);
    let mut len = 0;

    while len + 8 <= max_len {
        let a_start = a.len() - len - 8;
        let b_start = b.len() - len - 8;
        let a_chunk = u64::from_le_bytes(a[a_start..a_start + 8].try_into().unwrap());
        let b_chunk = u64::from_le_bytes(b[b_start..b_start + 8].try_into().unwrap());
        if a_chunk != b_chunk {
            break;
        }
        len += 8;
    }

    while len < max_len {
        if a[a.len() - len - 1] != b[b.len() - len - 1] {
            break;
        }
        len += 1;
    }

    len
}

/// Calculates the number of hash bits based on data size.
fn calculate_hash_bits(size: usize) -> u32 {
    let mut bits = 0u32;
    let mut temp = size + 10;
    while temp > 0 {
        bits += 1;
        temp >>= 1;
    }
    bits
}

/// Encodes the trivial case where prefix + suffix cover the entire base.
fn encode_trivial_case(
    new_data: &[u8],
    base_data: &[u8],
    prefix_size: usize,
    suffix_size: usize,
    instruction_stream: &mut BufferStream,
    data_stream: &mut BufferStream,
) {
    let new_size = new_data.len();
    let base_size = base_data.len();

    if prefix_size > 0 {
        let unit = DeltaUnit::copy(0, prefix_size as u64);
        write_delta_unit(instruction_stream, &unit);
    }

    let middle_size = new_size - prefix_size - suffix_size;
    if middle_size > 0 {
        let unit = DeltaUnit::literal(middle_size as u64);
        write_delta_unit(instruction_stream, &unit);
        data_stream.write_bytes(&new_data[prefix_size..new_size - suffix_size]);
    }

    if suffix_size > 0 {
        let unit = DeltaUnit::copy((base_size - suffix_size) as u64, suffix_size as u64);
        write_delta_unit(instruction_stream, &unit);
    }
}

/// Encodes the middle section of the data using hash table lookups.
#[allow(clippy::too_many_arguments)]
fn encode_middle_section(
    new_data: &[u8],
    base_data: &[u8],
    start: usize,
    end: usize,
    base_end: usize,
    hash_table: &[u32],
    hash_shift: u32,
    instruction_stream: &mut BufferStream,
    data_stream: &mut BufferStream,
) {
    if start >= end || end - start < WORD_SIZE {
        if start < end {
            let unit = DeltaUnit::literal((end - start) as u64);
            write_delta_unit(instruction_stream, &unit);
            data_stream.write_bytes(&new_data[start..end]);
        }
        return;
    }

    let mut pos = start;
    let mut literal_start = start;
    let mut fingerprint = compute_fingerprint(new_data, pos);

    while pos + WORD_SIZE <= end {
        let hash_index = (fingerprint >> hash_shift) as usize;
        let base_offset = hash_table[hash_index] as usize;

        if base_offset > 0
            && base_offset + WORD_SIZE <= base_end
            && new_data[pos..pos + WORD_SIZE] == base_data[base_offset..base_offset + WORD_SIZE]
        {
            let match_len = extend_match(new_data, base_data, pos, base_offset, end, base_end);

            if pos > literal_start {
                let lit_len = pos - literal_start;
                let unit = DeltaUnit::literal(lit_len as u64);
                write_delta_unit(instruction_stream, &unit);
                data_stream.write_bytes(&new_data[literal_start..pos]);
            }

            let unit = DeltaUnit::copy(base_offset as u64, match_len as u64);
            write_delta_unit(instruction_stream, &unit);

            pos += match_len;
            literal_start = pos;

            if pos + WORD_SIZE <= end {
                fingerprint = compute_fingerprint(new_data, pos);
            }
            continue;
        }

        pos += 1;
        if pos + WORD_SIZE <= end {
            fingerprint = roll_fingerprint(fingerprint, new_data[pos + WORD_SIZE - 1]);
        }
    }

    if literal_start < end {
        let lit_len = end - literal_start;
        let unit = DeltaUnit::literal(lit_len as u64);
        write_delta_unit(instruction_stream, &unit);
        data_stream.write_bytes(&new_data[literal_start..end]);
    }
}

/// Extends a match as far as possible.
fn extend_match(
    new_data: &[u8],
    base_data: &[u8],
    new_pos: usize,
    base_pos: usize,
    new_end: usize,
    base_end: usize,
) -> usize {
    let mut len = WORD_SIZE;

    while new_pos + len + 8 <= new_end && base_pos + len + 8 <= base_end {
        let new_chunk = u64::from_le_bytes(
            new_data[new_pos + len..new_pos + len + 8]
                .try_into()
                .unwrap(),
        );
        let base_chunk = u64::from_le_bytes(
            base_data[base_pos + len..base_pos + len + 8]
                .try_into()
                .unwrap(),
        );
        if new_chunk != base_chunk {
            break;
        }
        len += 8;
    }

    while new_pos + len < new_end
        && base_pos + len < base_end
        && new_data[new_pos + len] == base_data[base_pos + len]
    {
        len += 1;
    }

    len
}

/// Finalizes the delta by combining instruction and data streams.
fn finalize_delta(instruction_stream: &BufferStream, data_stream: &BufferStream) -> Vec<u8> {
    let mut result = BufferStream::with_capacity(instruction_stream.len() + data_stream.len() + 10);

    write_varint(&mut result, instruction_stream.len() as u64);
    result.write_bytes(instruction_stream.as_slice());
    result.write_bytes(data_stream.as_slice());

    result.into_vec()
}

/// Decodes a complete delta against the base data (one-shot convenience
/// over [`StreamDecoder`]; there is a single decode interpreter).
pub fn decode(delta: &[u8], base_data: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = StreamDecoder::new(base_data);
    decoder.push(delta)?;

    let mut output = Vec::new();
    let mut scratch = [0u8; 64 * 1024];
    loop {
        let n = decoder.read(&mut scratch)?;
        if n == 0 {
            break;
        }
        output.extend_from_slice(&scratch[..n]);
    }
    decoder.finish()?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::GDeltaError;

    #[test]
    fn find_common_prefix_works() {
        assert_eq!(find_common_prefix(b"Hello, World!", b"Hello, Rust!"), 7);
    }

    #[test]
    fn find_common_suffix_works() {
        assert_eq!(find_common_suffix(b"Hello, World!", b"Howdy, World!", 0), 8);
    }

    #[test]
    fn encode_decode_simple() {
        let base = b"The quick brown fox jumps over the lazy dog";
        let new = b"The quick brown cat jumps over the lazy dog";

        let delta = encode(new, base);
        let decoded = decode(&delta[..], base).unwrap();

        assert_eq!(decoded, new);
    }

    #[test]
    fn encode_decode_identical() {
        let data = b"Same data on both sides";

        let delta = encode(data, data);
        let decoded = decode(&delta[..], data).unwrap();

        assert_eq!(decoded, data);
        assert!(delta.len() < 20);
    }

    #[test]
    fn encode_decode_empty_new() {
        let base = b"Some base data";
        let delta = encode(b"", base);
        let decoded = decode(&delta[..], base).unwrap();
        assert!(decoded.is_empty());
    }

    #[test]
    fn encode_decode_empty_base() {
        let new = b"brand new content, nothing shared";
        let delta = encode(new, b"");
        let decoded = decode(&delta[..], b"").unwrap();
        assert_eq!(decoded, new);
    }

    #[test]
    fn encode_decode_large_patterned() {
        let mut base = vec![0u8; 100_000];
        let mut new = vec![0u8; 100_000];

        for i in 0..base.len() {
            base[i] = (i % 256) as u8;
            new[i] = (i % 256) as u8;
        }
        for i in (0..new.len()).step_by(488) {
            new[i] = new[i].wrapping_add(1);
        }

        let delta = encode(&new, &base);
        let decoded = decode(&delta, &base).unwrap();
        assert_eq!(decoded, new);
        assert!(delta.len() < new.len());
    }

    #[test]
    fn decode_rejects_truncated_header() {
        assert!(decode(&[], b"base").is_err());
    }

    #[test]
    fn decode_rejects_out_of_bounds_copy() {
        // Hand-built delta: one copy unit of length 32 at offset 0 against a
        // 4-byte base.
        let mut inst = BufferStream::with_capacity(8);
        write_delta_unit(&mut inst, &DeltaUnit::copy(0, 32));
        let mut delta = BufferStream::with_capacity(16);
        write_varint(&mut delta, inst.len() as u64);
        delta.write_bytes(inst.as_slice());
        assert_eq!(
            decode(delta.as_slice(), b"base"),
            Err(GDeltaError::OutOfBounds)
        );
    }
}
