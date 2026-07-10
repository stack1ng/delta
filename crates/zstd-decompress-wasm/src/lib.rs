//! C-ABI wasm exports for zstd streaming decompression only, as an
//! incremental transform with an optional exact window-byte limit.
//!
//! The context tracks the last `ZSTD_decompressStream` return value so the
//! caller can verify at end-of-input that the final frame was complete
//! (`zstd_decomp_done` == 1). When a window limit is set, each frame's
//! header is staged (at most 18 bytes) and parsed with
//! `ZSTD_getFrameHeader` before any of it reaches the decoder, so a frame
//! declaring a window larger than the limit is rejected byte-exactly and
//! before its history buffer is ever allocated.

use core::ffi::c_void;
use core::mem::MaybeUninit;
use std::alloc::{alloc, dealloc, Layout};
use zstd_sys::{
    ZSTD_DCtx, ZSTD_FrameHeader, ZSTD_createDCtx, ZSTD_decompressStream, ZSTD_freeDCtx,
    ZSTD_getFrameHeader, ZSTD_inBuffer, ZSTD_isError, ZSTD_outBuffer,
};

/// Upper bound of a zstd frame header (magic + descriptor + fields).
const FRAME_HEADER_MAX: usize = 18;

/// Window limit exceeded — distinct from generic corruption so the caller
/// can report the configured limit.
const ERR_WINDOW: i64 = -2;

struct DecompCtx {
    dctx: *mut ZSTD_DCtx,
    last_ret: usize,
    saw_input: bool,
    /// 0 disables the exact check (libzstd's own default limit still applies).
    window_limit: u64,
    /// Frame-header staging, active at each frame boundary while a window
    /// limit is set.
    hdr: [u8; FRAME_HEADER_MAX],
    hdr_len: usize,
    hdr_fed: usize,
    hdr_checked: bool,
}

impl DecompCtx {
    fn at_frame_start(&self) -> bool {
        self.window_limit > 0 && !self.hdr_checked
    }

    fn reset_frame_gate(&mut self) {
        self.hdr_len = 0;
        self.hdr_fed = 0;
        self.hdr_checked = false;
    }
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

/// Creates a decompression context. `window_limit` > 0 enforces an exact
/// upper bound (in bytes) on each frame's declared history window; 0 keeps
/// only libzstd's default limit. Returns 0 on failure.
#[unsafe(no_mangle)]
pub extern "C" fn zstd_decomp_new(window_limit: u64) -> u32 {
    unsafe {
        let dctx = ZSTD_createDCtx();
        if dctx.is_null() {
            return 0;
        }
        Box::into_raw(Box::new(DecompCtx {
            dctx,
            last_ret: 0,
            saw_input: false,
            window_limit,
            hdr: [0; FRAME_HEADER_MAX],
            hdr_len: 0,
            hdr_fed: 0,
            hdr_checked: false,
        })) as u32
    }
}

/// Runs one `ZSTD_decompressStream` step, keeping the shared bookkeeping
/// (frame-completion tracking, progress-only updates) in one place.
unsafe fn decompress_step(
    ctx: &mut DecompCtx,
    input: &mut ZSTD_inBuffer,
    output: &mut ZSTD_outBuffer,
) -> Result<(), i64> {
    let in_before = input.pos;
    let out_before = output.pos;
    let ret = unsafe { ZSTD_decompressStream(ctx.dctx, output, input) };
    if unsafe { ZSTD_isError(ret) } != 0 {
        return Err(-1);
    }
    // A no-op drain call after a completed frame makes zstd report the
    // header size it would want for a *next* frame; that must not clobber
    // the completion state, so only record progress-making calls.
    if input.pos != in_before || output.pos != out_before {
        ctx.last_ret = ret;
        if ret == 0 {
            // Frame boundary: the next input byte starts a new frame.
            ctx.reset_frame_gate();
        }
    }
    if input.pos != in_before {
        ctx.saw_input = true;
    }
    Ok(())
}

/// Decompresses input into output. Packs `(new_in_pos << 32) | out_written`
/// into the i64 result; negative means error (-1 corrupt/unsupported,
/// -2 frame window exceeds the configured limit).
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
    let src = if in_len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(in_ptr, in_len as usize) }
    };
    let mut pos = in_pos as usize;
    let mut output = ZSTD_outBuffer {
        dst: out_ptr as *mut c_void,
        size: out_cap as usize,
        pos: 0,
    };

    // Greedy: keep going until output is full or all offered input is
    // consumed/staged, so a call never returns without observable progress
    // when progress was possible (tiny concatenated frames included).
    loop {
        // Window gate: stage header bytes before the decoder sees them.
        if ctx.at_frame_start() {
            while ctx.hdr_len < FRAME_HEADER_MAX && pos < src.len() {
                ctx.hdr[ctx.hdr_len] = src[pos];
                ctx.hdr_len += 1;
                pos += 1;
            }
            let mut fh = MaybeUninit::<ZSTD_FrameHeader>::uninit();
            let ret = unsafe {
                ZSTD_getFrameHeader(
                    fh.as_mut_ptr(),
                    ctx.hdr.as_ptr() as *const c_void,
                    ctx.hdr_len,
                )
            };
            if unsafe { ZSTD_isError(ret) } != 0 {
                return -1;
            }
            if ret > 0 {
                // Header incomplete: everything offered so far is staged.
                break;
            }
            let fh = unsafe { fh.assume_init() };
            if fh.windowSize > ctx.window_limit {
                return ERR_WINDOW;
            }
            ctx.hdr_checked = true;
        }

        // Replay staged header bytes into the decoder before the live buffer.
        let mut restaged = false;
        while ctx.hdr_fed < ctx.hdr_len && output.pos < output.size {
            let mut staged = ZSTD_inBuffer {
                src: ctx.hdr.as_ptr() as *const c_void,
                size: ctx.hdr_len,
                pos: ctx.hdr_fed,
            };
            if let Err(code) = unsafe { decompress_step(ctx, &mut staged, &mut output) } {
                return code;
            }
            // The staged bytes may complete a tiny frame; the remainder then
            // belongs to the next frame and must pass the gate again.
            if ctx.at_frame_start() && staged.pos < ctx.hdr_len {
                let remaining = ctx.hdr_len - staged.pos;
                ctx.hdr.copy_within(staged.pos..ctx.hdr_len, 0);
                ctx.hdr_len = remaining;
                ctx.hdr_fed = 0;
                restaged = true;
                break;
            }
            ctx.hdr_fed = staged.pos;
        }
        if restaged {
            continue;
        }
        if ctx.hdr_fed < ctx.hdr_len {
            // Output full while replaying.
            break;
        }

        // Normal path over the caller's buffer.
        if pos >= src.len() || output.pos >= output.size {
            break;
        }
        let mut input = ZSTD_inBuffer {
            src: in_ptr as *const c_void,
            size: in_len as usize,
            pos,
        };
        if let Err(code) = unsafe { decompress_step(ctx, &mut input, &mut output) } {
            return code;
        }
        pos = input.pos;
        if !ctx.at_frame_start() {
            // Mid-frame: the pump loops for further output; only frame
            // boundaries need another gate pass here.
            break;
        }
    }

    ((pos as i64) << 32) | (output.pos as i64)
}

/// Returns 1 when at least one input byte was consumed and the stream ended
/// on a complete frame boundary. Zero input is not a valid zstd stream.
///
/// # Safety
/// `handle` must be a live context.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zstd_decomp_done(handle: u32) -> i32 {
    let ctx = unsafe { &*(handle as *const DecompCtx) };
    // Staged-but-unfed header bytes mean a frame was cut off mid-header.
    let staged_clean = ctx.hdr_fed == ctx.hdr_len;
    i32::from(ctx.saw_input && ctx.last_ret == 0 && staged_clean)
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
