//! C-ABI wasm exports for zstd streaming decompression only.
//!
//! The context tracks the last `ZSTD_decompressStream` return value so the
//! caller can verify at end-of-input that the final frame was complete
//! (`zstd_decomp_done` == 1).

use core::ffi::c_void;
use std::alloc::{Layout, alloc, dealloc};
use zstd_sys::{
    ZSTD_DCtx, ZSTD_DCtx_setParameter, ZSTD_createDCtx, ZSTD_dParameter, ZSTD_decompressStream,
    ZSTD_freeDCtx, ZSTD_inBuffer, ZSTD_isError, ZSTD_outBuffer,
};

struct DecompCtx {
    dctx: *mut ZSTD_DCtx,
    last_ret: usize,
    saw_input: bool,
}

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

/// Creates a decompression context. `window_log_max` > 0 caps the frame
/// window (frames requiring a larger history buffer are rejected instead of
/// allocated); 0 keeps libzstd's default limit. Returns 0 on failure.
#[unsafe(no_mangle)]
pub extern "C" fn zstd_decomp_new(window_log_max: i32) -> u32 {
    unsafe {
        let dctx = ZSTD_createDCtx();
        if dctx.is_null() {
            return 0;
        }
        if window_log_max > 0 {
            let ret = ZSTD_DCtx_setParameter(
                dctx,
                ZSTD_dParameter::ZSTD_d_windowLogMax,
                window_log_max,
            );
            if ZSTD_isError(ret) != 0 {
                ZSTD_freeDCtx(dctx);
                return 0;
            }
        }
        Box::into_raw(Box::new(DecompCtx {
            dctx,
            last_ret: 0,
            saw_input: false,
        })) as u32
    }
}

/// Decompresses input into output. Packs `(new_in_pos << 32) | out_written`
/// into the i64 result; negative means error (corrupt or unsupported data).
///
/// # Safety
/// `handle` must be a live context; buffer ranges must be valid wasm memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zstd_decomp_transform(
    handle: u32,
    in_ptr: *const u8,
    in_len: u32,
    in_pos: u32,
    out_ptr: *mut u8,
    out_cap: u32,
) -> i64 {
    let ctx = unsafe { &mut *(handle as *mut DecompCtx) };
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
    let ret = unsafe { ZSTD_decompressStream(ctx.dctx, &mut output, &mut input) };
    if unsafe { ZSTD_isError(ret) } != 0 {
        return -1;
    }
    // A no-op drain call after a completed frame makes zstd report the
    // header size it would want for a *next* frame; that must not clobber
    // the completion state, so only record progress-making calls.
    if input.pos != in_pos as usize || output.pos > 0 {
        ctx.last_ret = ret;
    }
    if input.pos != in_pos as usize {
        ctx.saw_input = true;
    }
    ((input.pos as i64) << 32) | (output.pos as i64)
}

/// Returns 1 when at least one input byte was consumed and the stream ended
/// on a complete frame boundary. Zero input is not a valid zstd stream.
///
/// # Safety
/// `handle` must be a live context.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zstd_decomp_done(handle: u32) -> i32 {
    let ctx = unsafe { &*(handle as *const DecompCtx) };
    i32::from(ctx.saw_input && ctx.last_ret == 0)
}

/// Frees the decompression context.
///
/// # Safety
/// `handle` must be a live context; it must not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zstd_decomp_free(handle: u32) {
    let ctx = unsafe { Box::from_raw(handle as *mut DecompCtx) };
    unsafe { ZSTD_freeDCtx(ctx.dctx) };
}
