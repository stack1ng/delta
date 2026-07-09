//! Incremental (streaming) delta decoder.
//!
//! The delta wire format is `varint(instruction_len) || instructions ||
//! literal data`. Decode therefore has to buffer the instruction block (small:
//! proportional to the number of instructions, not the data), after which
//! output is produced incrementally: copy instructions read straight from the
//! base, and literal instructions drain literal bytes as they arrive. Only
//! not-yet-consumed literal bytes are ever buffered.

use crate::error::{GDeltaError, Result};
use crate::varint::{DeltaUnit, parse_delta_unit, parse_varint};

/// Threshold above which the consumed prefix of the literal buffer is
/// compacted away.
const COMPACT_THRESHOLD: usize = 256 * 1024;

enum Stage {
    /// Accumulating the varint header + instruction block.
    Header,
    /// Instructions parsed; `buf` now holds pending literal data.
    Emit,
}

/// Push/pull streaming decoder over a borrowed base.
pub struct StreamDecoder<'a> {
    base: &'a [u8],
    buf: Vec<u8>,
    buf_pos: usize,
    units: Vec<DeltaUnit>,
    unit_idx: usize,
    unit_off: u64,
    stage: Stage,
}

impl<'a> StreamDecoder<'a> {
    /// Creates a decoder that reconstructs `new` against `base`.
    pub fn new(base: &'a [u8]) -> Self {
        Self {
            base,
            buf: Vec::new(),
            buf_pos: 0,
            units: Vec::new(),
            unit_idx: 0,
            unit_off: 0,
            stage: Stage::Header,
        }
    }

    /// Feeds the next chunk of delta bytes.
    pub fn push(&mut self, chunk: &[u8]) -> Result<()> {
        self.buf.extend_from_slice(chunk);
        if matches!(self.stage, Stage::Header) {
            self.try_parse_header()?;
        }
        Ok(())
    }

    fn try_parse_header(&mut self) -> Result<()> {
        let Some((inst_len, header_len)) = parse_varint(&self.buf) else {
            // An over-long varint (>10 bytes buffered without termination) is
            // malformed rather than merely incomplete.
            if self.buf.len() >= 10 {
                return Err(GDeltaError::InvalidDelta);
            }
            return Ok(());
        };

        let inst_len = usize::try_from(inst_len).map_err(|_| GDeltaError::InvalidDelta)?;
        let Some(inst_end) = header_len.checked_add(inst_len) else {
            return Err(GDeltaError::InvalidDelta);
        };
        if self.buf.len() < inst_end {
            return Ok(());
        }

        // Full instruction block available: parse and validate every unit.
        let mut pos = header_len;
        while pos < inst_end {
            let Some((unit, consumed)) = parse_delta_unit(&self.buf[pos..inst_end]) else {
                return Err(GDeltaError::InvalidDelta);
            };
            if unit.is_copy {
                let end = unit.offset.checked_add(unit.length);
                if end.is_none_or(|end| end > self.base.len() as u64) {
                    return Err(GDeltaError::OutOfBounds);
                }
            }
            self.units.push(unit);
            pos += consumed;
        }

        self.buf.drain(..inst_end);
        self.stage = Stage::Emit;
        Ok(())
    }

    /// Produces as many output bytes as currently possible into `out`.
    ///
    /// Returns the number of bytes written. Zero means more input is needed
    /// (or the output is complete).
    pub fn read(&mut self, out: &mut [u8]) -> usize {
        if !matches!(self.stage, Stage::Emit) {
            return 0;
        }

        let mut written = 0usize;
        while written < out.len() && self.unit_idx < self.units.len() {
            let unit = self.units[self.unit_idx];
            let remaining = unit.length - self.unit_off;
            // Zero-length units are format-representable (our encoder never
            // emits them, but a spec-valid third-party delta may): skip them
            // rather than mistaking "nothing to emit" for missing input.
            if remaining == 0 {
                self.unit_idx += 1;
                self.unit_off = 0;
                continue;
            }
            let space = (out.len() - written) as u64;

            let n = if unit.is_copy {
                let n = remaining.min(space) as usize;
                let src = (unit.offset + self.unit_off) as usize;
                out[written..written + n].copy_from_slice(&self.base[src..src + n]);
                n
            } else {
                let avail = (self.buf.len() - self.buf_pos) as u64;
                let n = remaining.min(space).min(avail) as usize;
                if n == 0 {
                    break;
                }
                out[written..written + n]
                    .copy_from_slice(&self.buf[self.buf_pos..self.buf_pos + n]);
                self.buf_pos += n;
                n
            };

            written += n;
            self.unit_off += n as u64;
            if self.unit_off == unit.length {
                self.unit_idx += 1;
                self.unit_off = 0;
            }
        }

        self.compact();
        written
    }

    fn compact(&mut self) {
        if self.buf_pos == self.buf.len() {
            self.buf.clear();
            self.buf_pos = 0;
        } else if self.buf_pos > COMPACT_THRESHOLD {
            self.buf.drain(..self.buf_pos);
            self.buf_pos = 0;
        }
    }

    /// Validates that the delta was complete and fully consumed.
    ///
    /// Call after the input ended and [`Self::read`] returned 0.
    pub fn finish(&self) -> Result<()> {
        if !matches!(self.stage, Stage::Emit) {
            return Err(GDeltaError::UnexpectedEndOfData);
        }
        if self.unit_idx < self.units.len() {
            return Err(GDeltaError::UnexpectedEndOfData);
        }
        if self.buf_pos < self.buf.len() {
            return Err(GDeltaError::TrailingData);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delta::encode;

    fn stream_decode(delta: &[u8], base: &[u8], chunk_size: usize) -> Result<Vec<u8>> {
        let mut decoder = StreamDecoder::new(base);
        let mut out = Vec::new();
        let mut scratch = [0u8; 97];

        for chunk in delta.chunks(chunk_size.max(1)) {
            decoder.push(chunk)?;
            loop {
                let n = decoder.read(&mut scratch);
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&scratch[..n]);
            }
        }
        loop {
            let n = decoder.read(&mut scratch);
            if n == 0 {
                break;
            }
            out.extend_from_slice(&scratch[..n]);
        }
        decoder.finish()?;
        Ok(out)
    }

    #[test]
    fn matches_one_shot_for_all_chunk_sizes() {
        let base: Vec<u8> = (0..10_000u32).flat_map(|i| i.to_le_bytes()).collect();
        let mut new = base.clone();
        new.extend_from_slice(b"appended tail data that is fresh");
        new[500..532].copy_from_slice(&[0xAB; 32]);

        let delta = encode(&new, &base);
        let expected = crate::delta::decode(&delta, &base).unwrap();
        assert_eq!(expected, new);

        for chunk_size in [1, 2, 3, 7, 64, 1024, delta.len()] {
            let out = stream_decode(&delta, &base, chunk_size).unwrap();
            assert_eq!(out, new, "chunk size {chunk_size}");
        }
    }

    #[test]
    fn empty_new_data() {
        let base = b"some base";
        let delta = encode(b"", base);
        let out = stream_decode(&delta, base, 1).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn truncated_delta_fails_finish() {
        let base = b"The quick brown fox jumps over the lazy dog";
        let new = b"The quick brown cat jumps over the lazy dog!!";
        let delta = encode(new, base);

        let mut decoder = StreamDecoder::new(base.as_slice());
        decoder.push(&delta[..delta.len() - 1]).unwrap();
        let mut scratch = [0u8; 256];
        while decoder.read(&mut scratch) > 0 {}
        assert!(decoder.finish().is_err());
    }

    #[test]
    fn trailing_junk_fails_finish() {
        let base = b"The quick brown fox jumps over the lazy dog";
        let new = b"The quick brown cat jumps over the lazy dog";
        let mut delta = encode(new, base);
        delta.push(0xFF);

        let mut decoder = StreamDecoder::new(base.as_slice());
        decoder.push(&delta).unwrap();
        let mut scratch = [0u8; 256];
        while decoder.read(&mut scratch) > 0 {}
        assert_eq!(decoder.finish(), Err(GDeltaError::TrailingData));
    }

    #[test]
    fn zero_length_literal_units_are_skipped() {
        // Spec-valid delta a third-party encoder could emit:
        // varint(3) || literal(0) || copy(0, 8) against an 8-byte base.
        let delta = [0x03, 0x00, 0x88, 0x00];
        let base = *b"abcdefgh";

        let mut decoder = StreamDecoder::new(base.as_slice());
        decoder.push(&delta).unwrap();
        let mut out = [0u8; 16];
        let n = decoder.read(&mut out);
        assert_eq!(&out[..n], b"abcdefgh");
        assert_eq!(decoder.read(&mut out), 0);
        decoder.finish().unwrap();

        // Trailing zero-length literal is equally fine.
        let delta = [0x03, 0x88, 0x00, 0x00];
        let mut decoder = StreamDecoder::new(base.as_slice());
        decoder.push(&delta).unwrap();
        let n = decoder.read(&mut out);
        assert_eq!(&out[..n], b"abcdefgh");
        assert_eq!(decoder.read(&mut out), 0);
        decoder.finish().unwrap();
    }

    #[test]
    fn out_of_bounds_copy_rejected_at_parse() {
        use crate::buffer::BufferStream;
        use crate::varint::{write_delta_unit, write_varint};

        let mut inst = BufferStream::with_capacity(8);
        write_delta_unit(&mut inst, &DeltaUnit::copy(0, 32));
        let mut delta = BufferStream::with_capacity(16);
        write_varint(&mut delta, inst.len() as u64);
        delta.write_bytes(inst.as_slice());

        let mut decoder = StreamDecoder::new(b"base".as_slice());
        assert_eq!(
            decoder.push(delta.as_slice()),
            Err(GDeltaError::OutOfBounds)
        );
    }
}
