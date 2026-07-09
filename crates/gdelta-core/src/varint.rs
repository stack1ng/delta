//! Variable-length integer and delta-instruction encoding.
//!
//! Adapted from the MIT-licensed `gdelta` crate by Oliver Seifert
//! (<https://github.com/ImGajeed76/gdelta>). See NOTICE at the repository root.
//!
//! Wire format of one instruction ("delta unit"):
//! - Head byte: `[copy:1][more:1][length:6]`
//! - If `more`: varint holding the remaining high bits of the length
//! - If `copy`: varint holding the base offset

use crate::buffer::BufferStream;

/// Number of value bits per byte in varint encoding.
const VARINT_BITS: u8 = 7;

/// Mask for extracting varint value bits.
const VARINT_MASK: u64 = (1 << VARINT_BITS) - 1;

/// Number of value bits in the head byte of a delta unit.
const HEAD_VARINT_BITS: u8 = 6;

/// Mask for extracting head varint value bits.
const HEAD_VARINT_MASK: u64 = (1 << HEAD_VARINT_BITS) - 1;

/// Writes a variable-length integer to the buffer.
pub fn write_varint(buffer: &mut BufferStream, value: u64) {
    if value < 128 {
        buffer.write_u8(value as u8);
        return;
    }

    if value < 16384 {
        buffer.write_u8(((value & 0x7F) | 0x80) as u8);
        buffer.write_u8((value >> 7) as u8);
        return;
    }

    let mut val = value;
    loop {
        let byte_val = (val & VARINT_MASK) as u8;
        val >>= VARINT_BITS;
        if val == 0 {
            buffer.write_u8(byte_val);
            break;
        }
        buffer.write_u8(byte_val | 0x80);
    }
}

/// Parses a varint from the front of `buf` without consuming it.
///
/// Returns `None` when `buf` does not yet contain a complete varint, which
/// makes this safe to call across chunk boundaries in the streaming decoder.
pub fn parse_varint(buf: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0u32;
    for (i, &byte) in buf.iter().enumerate() {
        // 10 bytes bound any u64 varint; reject longer sequences.
        if i >= 10 {
            return None;
        }
        value |= u64::from(byte & 0x7F) << shift;
        if (byte & 0x80) == 0 {
            return Some((value, i + 1));
        }
        shift += 7;
    }
    None
}

/// A delta instruction unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeltaUnit {
    /// If true, this is a copy instruction; if false, it's a literal.
    pub is_copy: bool,
    /// Length of the data to copy or literal data length.
    pub length: u64,
    /// For copy instructions, the offset in the base data.
    pub offset: u64,
}

impl DeltaUnit {
    /// Creates a new copy instruction.
    pub fn copy(offset: u64, length: u64) -> Self {
        Self {
            is_copy: true,
            length,
            offset,
        }
    }

    /// Creates a new literal instruction.
    pub fn literal(length: u64) -> Self {
        Self {
            is_copy: false,
            length,
            offset: 0,
        }
    }
}

/// Writes a delta unit to the buffer.
pub fn write_delta_unit(buffer: &mut BufferStream, unit: &DeltaUnit) {
    let flag = u8::from(unit.is_copy);
    let head_length = (unit.length & HEAD_VARINT_MASK) as u8;
    let remaining_length = unit.length >> HEAD_VARINT_BITS;
    let more = u8::from(remaining_length > 0);

    let head_byte = (flag << 7) | (more << 6) | head_length;
    buffer.write_u8(head_byte);

    if remaining_length > 0 {
        write_varint(buffer, remaining_length);
    }

    if unit.is_copy {
        write_varint(buffer, unit.offset);
    }
}

/// Parses a delta unit from the front of `buf` without consuming it.
///
/// Returns `None` when `buf` does not yet contain a complete unit.
pub fn parse_delta_unit(buf: &[u8]) -> Option<(DeltaUnit, usize)> {
    let head_byte = *buf.first()?;
    let mut consumed = 1usize;

    let is_copy = (head_byte & 0x80) != 0;
    let more = (head_byte & 0x40) != 0;
    let mut length = u64::from(head_byte & 0x3F);

    if more {
        let (remaining, n) = parse_varint(&buf[consumed..])?;
        length |= remaining << HEAD_VARINT_BITS;
        consumed += n;
    }

    let offset = if is_copy {
        let (offset, n) = parse_varint(&buf[consumed..])?;
        consumed += n;
        offset
    } else {
        0
    };

    Some((
        DeltaUnit {
            is_copy,
            length,
            offset,
        },
        consumed,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip_unit(unit: DeltaUnit) {
        let mut buffer = BufferStream::with_capacity(20);
        write_delta_unit(&mut buffer, &unit);
        let (decoded, consumed) = parse_delta_unit(buffer.as_slice()).unwrap();
        assert_eq!(decoded, unit);
        assert_eq!(consumed, buffer.len());
    }

    #[test]
    fn varint_roundtrip() {
        for value in [0u64, 1, 127, 128, 16383, 16384, 1 << 40, u64::MAX] {
            let mut buffer = BufferStream::with_capacity(10);
            write_varint(&mut buffer, value);
            let (parsed, consumed) = parse_varint(buffer.as_slice()).unwrap();
            assert_eq!(parsed, value);
            assert_eq!(consumed, buffer.len());
        }
    }

    #[test]
    fn varint_incomplete_returns_none() {
        assert_eq!(parse_varint(&[]), None);
        assert_eq!(parse_varint(&[0x80]), None);
        assert_eq!(parse_varint(&[0x80, 0x80]), None);
    }

    #[test]
    fn delta_unit_roundtrip() {
        roundtrip_unit(DeltaUnit::copy(1000, 500));
        roundtrip_unit(DeltaUnit::literal(250));
        roundtrip_unit(DeltaUnit::literal(100_000));
        roundtrip_unit(DeltaUnit::copy(0, 1));
    }

    #[test]
    fn delta_unit_incomplete_returns_none() {
        let mut buffer = BufferStream::with_capacity(20);
        write_delta_unit(&mut buffer, &DeltaUnit::copy(100_000, 90_000));
        let bytes = buffer.as_slice();
        for cut in 0..bytes.len() {
            assert_eq!(parse_delta_unit(&bytes[..cut]), None);
        }
    }
}
