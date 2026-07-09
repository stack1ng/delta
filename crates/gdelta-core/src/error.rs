//! Error types. String payloads are intentionally avoided to keep the wasm
//! artifacts free of formatting machinery.

/// Errors produced while decoding a delta.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GDeltaError {
    /// Ran off the end of the input while reading.
    UnexpectedEndOfData,
    /// The delta is structurally malformed (bad header or instruction).
    InvalidDelta,
    /// A copy instruction references bytes outside the base data.
    OutOfBounds,
    /// Input bytes remain after all instructions were satisfied.
    TrailingData,
}

/// Result alias used throughout the crate.
pub type Result<T> = core::result::Result<T, GDeltaError>;
