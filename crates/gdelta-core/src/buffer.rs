//! Append-only output buffer used by the encoder.
//!
//! Adapted from the MIT-licensed `gdelta` crate by Oliver Seifert
//! (<https://github.com/ImGajeed76/gdelta>). See NOTICE at the repository
//! root. Decoding reads through the slice-based parsers in `varint` and the
//! incremental `stream::StreamDecoder` instead, so no read cursor lives here.

/// Initial buffer size for allocations.
pub const INIT_BUFFER_SIZE: usize = 128 * 1024;

/// A growable append-only byte buffer.
pub struct BufferStream {
    buffer: Vec<u8>,
}

impl BufferStream {
    /// Creates a new buffer with the specified initial capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            buffer: Vec::with_capacity(capacity),
        }
    }

    /// Returns a reference to the underlying buffer.
    #[inline]
    pub fn as_slice(&self) -> &[u8] {
        &self.buffer[..]
    }

    /// Consumes the buffer and returns the underlying vector.
    #[inline]
    pub fn into_vec(self) -> Vec<u8> {
        self.buffer
    }

    /// Returns the total length of the buffer.
    #[inline]
    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    /// Writes a single byte to the buffer.
    pub fn write_u8(&mut self, value: u8) {
        self.buffer.push(value);
    }

    /// Writes a slice of bytes to the buffer.
    pub fn write_bytes(&mut self, data: &[u8]) {
        self.buffer.extend_from_slice(data);
    }
}
