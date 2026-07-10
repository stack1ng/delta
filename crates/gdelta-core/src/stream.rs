//! Incremental (streaming) delta decoder.
//!
//! The delta wire format is `varint(instruction_len) || instructions ||
//! literal data`. The decoder buffers the raw instruction block (bounded by
//! the patch bytes actually pushed) and parses instructions **on demand**
//! while emitting — a patch containing millions of tiny instructions costs
//! only its own byte length, never a materialized instruction list. Copy
//! instructions read straight from the base; literal instructions drain
//! literal bytes as they arrive, and only not-yet-consumed literal bytes
//! stay buffered.

use crate::error::{GDeltaError, Result};
use crate::varint::{parse_delta_unit, parse_varint, DeltaUnit, Parsed};

/// Threshold above which the consumed prefix of the literal buffer is
/// compacted away.
const COMPACT_THRESHOLD: usize = 256 * 1024;

enum Stage {
    /// Accumulating the varint header + instruction block.
    Header,
    /// Instruction block complete; `buf` now holds pending literal data.
    Emit,
}

/// Push/pull streaming decoder over a borrowed base.
pub struct StreamDecoder<'a> {
    base: &'a [u8],
    /// Header stage: raw delta bytes. Emit stage: pending literal data.
    buf: Vec<u8>,
    buf_pos: usize,
    /// Raw instruction block, parsed lazily during [`Self::read`].
    inst: Vec<u8>,
    inst_pos: usize,
    /// Unit currently being emitted, with progress.
    current: Option<DeltaUnit>,
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
            inst: Vec::new(),
            inst_pos: 0,
            current: None,
            unit_off: 0,
            stage: Stage::Header,
        }
    }

    /// Feeds the next chunk of delta bytes.
    pub fn push(&mut self, chunk: &[u8]) -> Result<()> {
        self.buf.extend_from_slice(chunk);
        if matches!(self.stage, Stage::Header) {
            self.try_take_instructions()?;
        }
        Ok(())
    }

    fn try_take_instructions(&mut self) -> Result<()> {
        let (inst_len, header_len) = match parse_varint(&self.buf) {
            Parsed::Incomplete => return Ok(()),
            Parsed::Invalid => return Err(GDeltaError::InvalidDelta),
            Parsed::Done(value, consumed) => (value, consumed),
        };

        let inst_len = usize::try_from(inst_len).map_err(|_| GDeltaError::InvalidDelta)?;
        let Some(inst_end) = header_len.checked_add(inst_len) else {
            return Err(GDeltaError::InvalidDelta);
        };
        if self.buf.len() < inst_end {
            return Ok(());
        }

        self.inst = self.buf[header_len..inst_end].to_vec();
        self.buf.drain(..inst_end);
        self.stage = Stage::Emit;
        Ok(())
    }

    /// Advances to the next non-empty unit, validating as it parses.
    /// Returns `Ok(false)` when all instructions are exhausted.
    fn next_unit(&mut self) -> Result<bool> {
        while self.inst_pos < self.inst.len() {
            match parse_delta_unit(&self.inst[self.inst_pos..]) {
                // The block is complete by construction, so a unit that
                // cannot finish parsing inside it is malformed.
                Parsed::Incomplete | Parsed::Invalid => return Err(GDeltaError::InvalidDelta),
                Parsed::Done(unit, consumed) => {
                    // Bounds are validated before the zero-length skip to
                    // match the upstream reference: copy(base.len(), 0) is
                    // accepted, copy(base.len() + 1, 0) is not.
                    if unit.is_copy {
                        let end = unit.offset.checked_add(unit.length);
                        if end.is_none_or(|end| end > self.base.len() as u64) {
                            return Err(GDeltaError::OutOfBounds);
                        }
                    }
                    self.inst_pos += consumed;
                    // Zero-length units are format-representable (our encoder
                    // never emits them, but a spec-valid third-party delta
                    // may): skip rather than stall on them.
                    if unit.length == 0 {
                        continue;
                    }
                    self.current = Some(unit);
                    self.unit_off = 0;
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// Produces as many output bytes as currently possible into `out`.
    ///
    /// Returns the number of bytes written; zero means more input is needed
    /// (or the output is complete). Malformed or out-of-bounds instructions
    /// surface here, at the point they are first needed.
    pub fn read(&mut self, out: &mut [u8]) -> Result<usize> {
        if !matches!(self.stage, Stage::Emit) {
            return Ok(0);
        }

        let mut written = 0usize;
        loop {
            // Advance to the next real unit even when `out` has no space:
            // trailing zero-length units must be consumed so finish() sees a
            // complete patch regardless of output-buffer sizing.
            if self.current.is_none() && !self.next_unit()? {
                break;
            }
            if written >= out.len() {
                break;
            }
            let unit = self.current.expect("just ensured");
            let remaining = unit.length - self.unit_off;
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
                self.current = None;
            }
        }

        self.compact();
        Ok(written)
    }

    fn compact(&mut self) {
        if self.buf_pos == self.buf.len() {
            self.buf.clear();
            self.buf_pos = 0;
        } else if self.buf_pos > COMPACT_THRESHOLD && self.buf_pos >= self.buf.len() / 2 {
            // Only compact once at least half the buffer is consumed: each
            // byte is then shifted O(1) times amortized, keeping large
            // single-chunk literal patches linear instead of quadratic.
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
        if self.current.is_some() || self.inst_pos < self.inst.len() {
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
    use crate::buffer::BufferStream;
    use crate::delta::encode;
    use crate::varint::{write_delta_unit, write_varint};

    fn stream_decode(delta: &[u8], base: &[u8], chunk_size: usize) -> Result<Vec<u8>> {
        let mut decoder = StreamDecoder::new(base);
        let mut out = Vec::new();
        let mut scratch = [0u8; 97];

        for chunk in delta.chunks(chunk_size.max(1)) {
            decoder.push(chunk)?;
            loop {
                let n = decoder.read(&mut scratch)?;
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&scratch[..n]);
            }
        }
        loop {
            let n = decoder.read(&mut scratch)?;
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
        while decoder.read(&mut scratch).unwrap() > 0 {}
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
        while decoder.read(&mut scratch).unwrap() > 0 {}
        assert_eq!(decoder.finish(), Err(GDeltaError::TrailingData));
    }

    #[test]
    fn out_of_bounds_copy_rejected_when_reached() {
        let mut inst = BufferStream::with_capacity(8);
        write_delta_unit(&mut inst, &DeltaUnit::copy(0, 32));
        let mut delta = BufferStream::with_capacity(16);
        write_varint(&mut delta, inst.len() as u64);
        delta.write_bytes(inst.as_slice());

        let mut decoder = StreamDecoder::new(b"base".as_slice());
        decoder.push(delta.as_slice()).unwrap();
        let mut scratch = [0u8; 64];
        assert_eq!(decoder.read(&mut scratch), Err(GDeltaError::OutOfBounds));
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
        let n = decoder.read(&mut out).unwrap();
        assert_eq!(&out[..n], b"abcdefgh");
        assert_eq!(decoder.read(&mut out).unwrap(), 0);
        decoder.finish().unwrap();

        // Trailing zero-length literal is equally fine.
        let delta = [0x03, 0x88, 0x00, 0x00];
        let mut decoder = StreamDecoder::new(base.as_slice());
        decoder.push(&delta).unwrap();
        let n = decoder.read(&mut out).unwrap();
        assert_eq!(&out[..n], b"abcdefgh");
        assert_eq!(decoder.read(&mut out).unwrap(), 0);
        decoder.finish().unwrap();
    }

    #[test]
    fn zero_length_copy_bounds_match_upstream() {
        // Upstream accepts copy offsets up to base.len() inclusive for
        // zero-length units and rejects anything beyond.
        let base = b"abcdefgh";
        let mut out = [0u8; 8];

        // varint(2) || copy(8, 0): offset == base.len() is in bounds.
        let mut decoder = StreamDecoder::new(base.as_slice());
        decoder.push(&[0x02, 0x80, 0x08]).unwrap();
        assert_eq!(decoder.read(&mut out).unwrap(), 0);
        decoder.finish().unwrap();

        // varint(2) || copy(99, 0): out of bounds, upstream rejects.
        let mut decoder = StreamDecoder::new(base.as_slice());
        decoder.push(&[0x02, 0x80, 0x63]).unwrap();
        assert_eq!(decoder.read(&mut out), Err(GDeltaError::OutOfBounds));
    }

    #[test]
    fn large_single_chunk_literal_stays_linear() {
        // 8 MiB literal pushed as ONE chunk, drained in 64 KiB reads: the
        // amortized compaction must not shift the tail per read. (A
        // correctness gate; the quadratic regression showed up as huge
        // wall-time growth in external probes.)
        let size = 8 * 1024 * 1024usize;
        let data = vec![0xA5u8; size];
        let mut inst = BufferStream::with_capacity(8);
        write_delta_unit(&mut inst, &DeltaUnit::literal(size as u64));
        let mut delta = Vec::new();
        {
            let mut header = BufferStream::with_capacity(4);
            write_varint(&mut header, inst.len() as u64);
            delta.extend_from_slice(header.as_slice());
        }
        delta.extend_from_slice(inst.as_slice());
        delta.extend_from_slice(&data);

        let mut decoder = StreamDecoder::new(b"".as_slice());
        decoder.push(&delta).unwrap();
        let mut scratch = vec![0u8; 64 * 1024];
        let mut total = 0usize;
        loop {
            let n = decoder.read(&mut scratch).unwrap();
            if n == 0 {
                break;
            }
            total += n;
        }
        assert_eq!(total, size);
        decoder.finish().unwrap();
    }

    #[test]
    fn zero_capacity_reads_still_consume_trailing_units() {
        // varint(1) || literal(0): a valid empty-output patch must finish
        // cleanly even if the caller only ever offers an empty out buffer.
        let delta = [0x01, 0x00];
        let mut decoder = StreamDecoder::new(b"".as_slice());
        decoder.push(&delta).unwrap();
        assert_eq!(decoder.read(&mut []).unwrap(), 0);
        decoder.finish().unwrap();
    }

    #[test]
    fn overflowing_header_varint_is_rejected() {
        // Nine continuation bytes then 0x02: value would be 2^64.
        let mut delta = vec![0x80u8; 9];
        delta.push(0x02);
        let mut decoder = StreamDecoder::new(b"base".as_slice());
        assert_eq!(decoder.push(&delta), Err(GDeltaError::InvalidDelta));
    }

    #[test]
    fn overflowing_unit_length_is_rejected() {
        // Block: literal head with `more`, then a u64::MAX extension varint
        // (which cannot be shifted left by 6 without overflow).
        let mut inst = vec![0x40u8];
        inst.extend_from_slice(&[0xFF; 9]);
        inst.push(0x01);
        let mut delta = vec![inst.len() as u8];
        delta.extend_from_slice(&inst);

        let mut decoder = StreamDecoder::new(b"base".as_slice());
        decoder.push(&delta).unwrap();
        let mut scratch = [0u8; 16];
        assert_eq!(decoder.read(&mut scratch), Err(GDeltaError::InvalidDelta));
    }

    #[test]
    fn instruction_heavy_patch_stays_lean() {
        // 100k zero-length literals followed by one real copy: memory should
        // stay proportional to the pushed bytes (no materialized unit list),
        // and decode should still succeed.
        let base = *b"abcdefgh";
        let mut inst = vec![0x00u8; 100_000];
        inst.push(0x88);
        inst.push(0x00);
        let mut delta = Vec::new();
        {
            let mut header = BufferStream::with_capacity(4);
            write_varint(&mut header, inst.len() as u64);
            delta.extend_from_slice(header.as_slice());
        }
        delta.extend_from_slice(&inst);

        let mut decoder = StreamDecoder::new(base.as_slice());
        decoder.push(&delta).unwrap();
        let mut out = [0u8; 16];
        let n = decoder.read(&mut out).unwrap();
        assert_eq!(&out[..n], b"abcdefgh");
        assert_eq!(decoder.read(&mut out).unwrap(), 0);
        decoder.finish().unwrap();
    }
}
