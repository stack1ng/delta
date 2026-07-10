//! C-ABI wasm exports for GDelta encode only.
//!
//! Memory protocol: JS allocates input buffers with `walloc`, copies data in,
//! calls `gdelta_encode`, then reads the result out of wasm memory via
//! `gdelta_result_ptr`/`gdelta_result_len` and frees both sides.

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

/// Encodes a delta; returns an opaque result handle (never 0).
///
/// # Safety
/// Pointers must reference `len` readable bytes inside wasm memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gdelta_encode(
    new_ptr: *const u8,
    new_len: u32,
    base_ptr: *const u8,
    base_len: u32,
) -> u32 {
    let new_data = slice_from(new_ptr, new_len);
    let base_data = slice_from(base_ptr, base_len);
    let delta = gdelta_core::encode(new_data, base_data);
    Box::into_raw(Box::new(delta)) as u32
}

/// Returns the pointer to the delta bytes held by a result handle.
///
/// # Safety
/// `handle` must come from `gdelta_encode` and not yet be freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gdelta_result_ptr(handle: u32) -> *const u8 {
    let delta = unsafe { &*(handle as *const Vec<u8>) };
    delta.as_ptr()
}

/// Returns the length of the delta held by a result handle.
///
/// # Safety
/// `handle` must come from `gdelta_encode` and not yet be freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gdelta_result_len(handle: u32) -> u32 {
    let delta = unsafe { &*(handle as *const Vec<u8>) };
    delta.len() as u32
}

/// Frees a result handle and its delta bytes.
///
/// # Safety
/// `handle` must come from `gdelta_encode` and not yet be freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gdelta_result_free(handle: u32) {
    drop(unsafe { Box::from_raw(handle as *mut Vec<u8>) });
}
