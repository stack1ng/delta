//! C-ABI wasm exports for GDelta decode only, as an incremental push/pull
//! decoder: push delta chunks in, read reconstructed output out.
//!
//! Memory protocol: JS allocates the base buffer with `walloc` and MUST keep
//! it alive (not `wfree` it) until `gdelta_decoder_free` — the decoder
//! borrows the base rather than copying it.

use gdelta_core::StreamDecoder;
use std::alloc::{alloc, dealloc, Layout};

/// Allocates `len` bytes (1-aligned) inside wasm memory. Returns null when
/// the size is unrepresentable or memory is exhausted.
#[unsafe(no_mangle)]
pub extern "C" fn walloc(len: u32) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    match Layout::from_size_align(len as usize, 1) {
        Ok(layout) => unsafe { alloc(layout) },
        Err(_) => core::ptr::null_mut(),
    }
}

/// Frees a buffer previously returned by `walloc`.
///
/// # Safety
/// `ptr`/`len` must come from a matching `walloc` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wfree(ptr: *mut u8, len: u32) {
    if ptr.is_null() || len == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(len as usize, 1) {
        unsafe { dealloc(ptr, layout) };
    }
}

fn slice_from<'a>(ptr: *const u8, len: u32) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len as usize) }
    }
}

fn error_code(err: gdelta_core::GDeltaError) -> i32 {
    match err {
        gdelta_core::GDeltaError::UnexpectedEndOfData => -1,
        gdelta_core::GDeltaError::InvalidDelta => -2,
        gdelta_core::GDeltaError::OutOfBounds => -3,
        gdelta_core::GDeltaError::TrailingData => -4,
    }
}

/// Creates a decoder over a base buffer living in wasm memory.
///
/// # Safety
/// `base_ptr..base_ptr+base_len` must stay valid until `gdelta_decoder_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gdelta_decoder_new(base_ptr: *const u8, base_len: u32) -> u32 {
    let base: &'static [u8] = slice_from(base_ptr, base_len);
    Box::into_raw(Box::new(StreamDecoder::new(base))) as u32
}

/// Feeds a chunk of delta bytes. Returns 0 on success, negative on error.
///
/// # Safety
/// `handle` must be a live decoder; the chunk must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gdelta_decoder_push(handle: u32, ptr: *const u8, len: u32) -> i32 {
    let decoder = unsafe { &mut *(handle as *mut StreamDecoder<'static>) };
    match decoder.push(slice_from(ptr, len)) {
        Ok(()) => 0,
        Err(err) => error_code(err),
    }
}

/// Drains decoded output into `out_ptr`. Returns bytes written (0 = drained),
/// or a negative error code when a malformed/out-of-bounds instruction is
/// reached (instructions parse lazily during emission).
///
/// # Safety
/// `handle` must be a live decoder; `out_ptr` must have `out_cap` writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gdelta_decoder_read(handle: u32, out_ptr: *mut u8, out_cap: u32) -> i32 {
    let decoder = unsafe { &mut *(handle as *mut StreamDecoder<'static>) };
    // Clamp so a successful read can never wrap into the negative error
    // range, whatever capacity a caller passes.
    let out_cap = out_cap.min(i32::MAX as u32);
    if out_cap == 0 {
        return 0;
    }
    let out = unsafe { std::slice::from_raw_parts_mut(out_ptr, out_cap as usize) };
    match decoder.read(out) {
        Ok(n) => n as i32,
        Err(err) => error_code(err),
    }
}

/// Validates completion after the delta input ended and output was drained.
/// Returns 0 when the delta was complete and fully consumed.
///
/// # Safety
/// `handle` must be a live decoder.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gdelta_decoder_finish(handle: u32) -> i32 {
    let decoder = unsafe { &*(handle as *const StreamDecoder<'static>) };
    match decoder.finish() {
        Ok(()) => 0,
        Err(err) => error_code(err),
    }
}

/// Frees the decoder. The base buffer may be freed after this returns.
///
/// # Safety
/// `handle` must be a live decoder; it must not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gdelta_decoder_free(handle: u32) {
    drop(unsafe { Box::from_raw(handle as *mut StreamDecoder<'static>) });
}
