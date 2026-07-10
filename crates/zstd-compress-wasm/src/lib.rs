//! C-ABI wasm exports for zstd streaming compression only.
//!
//! The transform call mirrors `ZSTD_compressStream2` semantics: the caller
//! loops, tracking how much input was consumed and how much output was
//! produced, so no intermediate buffers accumulate on the Rust side.

use core::ffi::c_void;
use std::alloc::{alloc, dealloc, Layout};
use zstd_sys::{
    ZSTD_CCtx, ZSTD_CCtx_setParameter, ZSTD_EndDirective, ZSTD_cParameter, ZSTD_compressStream2,
    ZSTD_createCCtx, ZSTD_freeCCtx, ZSTD_inBuffer, ZSTD_isError, ZSTD_outBuffer,
};

/// Allocates `len` bytes (1-aligned) inside wasm memory.
///
/// # Safety
/// `len` must be non-zero.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn walloc(len: u32) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align_unchecked(len as usize, 1)) }
}

/// Frees a buffer previously returned by `walloc`.
///
/// # Safety
/// `ptr`/`len` must come from a matching `walloc` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wfree(ptr: *mut u8, len: u32) {
    unsafe { dealloc(ptr, Layout::from_size_align_unchecked(len as usize, 1)) }
}

/// Creates a compression context at `level`. Returns 0 on failure.
#[unsafe(no_mangle)]
pub extern "C" fn zstd_comp_new(level: i32) -> u32 {
    unsafe {
        let cctx = ZSTD_createCCtx();
        if cctx.is_null() {
            return 0;
        }
        let ret = ZSTD_CCtx_setParameter(cctx, ZSTD_cParameter::ZSTD_c_compressionLevel, level);
        if ZSTD_isError(ret) != 0 {
            ZSTD_freeCCtx(cctx);
            return 0;
        }
        cctx as u32
    }
}

/// Compresses input into output. Packs `(new_in_pos << 32) | out_written`
/// into the i64 result; negative means error.
///
/// # Safety
/// `handle` must be a live context; buffer ranges must be valid wasm memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zstd_comp_transform(
    handle: u32,
    in_ptr: *const u8,
    in_len: u32,
    in_pos: u32,
    out_ptr: *mut u8,
    out_cap: u32,
) -> i64 {
    let cctx = handle as *mut ZSTD_CCtx;
    let mut input = ZSTD_inBuffer {
        src: in_ptr as *const c_void,
        size: in_len as usize,
        pos: in_pos as usize,
    };
    let mut output = ZSTD_outBuffer {
        dst: out_ptr as *mut c_void,
        size: out_cap as usize,
        pos: 0,
    };
    let ret = unsafe {
        ZSTD_compressStream2(
            cctx,
            &mut output,
            &mut input,
            ZSTD_EndDirective::ZSTD_e_continue,
        )
    };
    if unsafe { ZSTD_isError(ret) } != 0 {
        return -1;
    }
    ((input.pos as i64) << 32) | (output.pos as i64)
}

/// Flushes and finalizes the frame. Packs `(remaining << 32) | out_written`;
/// the caller loops until `remaining == 0`. Negative means error.
///
/// # Safety
/// `handle` must be a live context; the output range must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zstd_comp_end(handle: u32, out_ptr: *mut u8, out_cap: u32) -> i64 {
    let cctx = handle as *mut ZSTD_CCtx;
    let mut input = ZSTD_inBuffer {
        src: core::ptr::null(),
        size: 0,
        pos: 0,
    };
    let mut output = ZSTD_outBuffer {
        dst: out_ptr as *mut c_void,
        size: out_cap as usize,
        pos: 0,
    };
    let ret = unsafe {
        ZSTD_compressStream2(cctx, &mut output, &mut input, ZSTD_EndDirective::ZSTD_e_end)
    };
    if unsafe { ZSTD_isError(ret) } != 0 {
        return -1;
    }
    ((ret as i64) << 32) | (output.pos as i64)
}

/// Frees the compression context.
///
/// # Safety
/// `handle` must be a live context; it must not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zstd_comp_free(handle: u32) {
    unsafe { ZSTD_freeCCtx(handle as *mut ZSTD_CCtx) };
}
