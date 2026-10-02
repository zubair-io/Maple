//! Pure workflow conversion (#4036). Hosts own atomic sidecar publication.
use crate::error::{catch_panic_rc, set_last_error};
use raw_core::workflow::{SidecarWorkflow, WORKFLOW_MAX_BYTES};

unsafe fn input<'a>(ptr: *const u8, len: usize) -> Result<&'a str, String> {
    if ptr.is_null() || len > WORKFLOW_MAX_BYTES {
        return Err("workflow input is null or exceeds byte budget".into());
    }
    std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).map_err(|e| e.to_string())
}
unsafe fn output(
    entry: &str,
    out: *mut u8,
    cap: usize,
    len: *mut usize,
    convert: impl FnOnce() -> Result<String, String>,
) -> i32 {
    catch_panic_rc(entry, || {
        if out.is_null() || len.is_null() {
            set_last_error(format!("{entry}: null output pointer"));
            return -1;
        }
        match convert() {
            Ok(value) if value.len() <= cap => {
                std::ptr::copy_nonoverlapping(value.as_ptr(), out, value.len());
                *len = value.len();
                0
            }
            Ok(_) => {
                set_last_error(format!("{entry}: output exceeds caller buffer"));
                2
            }
            Err(error) => {
                set_last_error(format!("{entry}: {error}"));
                1
            }
        }
    })
}

/// Validate a complete workflow JSON record and return canonical JSON.
/// Returns 0 on success, 1 for invalid input, 2 for a short output buffer,
/// -1 for null output pointers, or 99 for a caught panic. Failures never
/// change the output buffer or length. Output bytes are not NUL terminated.
///
/// # Safety
/// Inputs must be readable for their lengths; out must be writable for cap
/// bytes and out_len for one usize. Input/output regions must not overlap.
#[no_mangle]
pub unsafe extern "C" fn maple_workflow_validate_json(
    json: *const u8,
    json_len: usize,
    out: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    output(
        "maple_workflow_validate_json",
        out,
        out_cap,
        out_len,
        || SidecarWorkflow::parse(input(json, json_len)?)?.to_json(),
    )
}

/// Read workflow metadata from complete XMP; absent metadata returns `null`
/// JSON. Same return codes and unchanged-on-failure contract as validation.
///
/// # Safety
/// Same pointer, length and non-overlap requirements as maple_workflow_validate_json.
#[no_mangle]
pub unsafe extern "C" fn maple_workflow_read_xmp(
    xmp: *const u8,
    xmp_len: usize,
    out: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    output("maple_workflow_read_xmp", out, out_cap, out_len, || {
        SidecarWorkflow::from_xmp(input(xmp, xmp_len)?)?
            .map_or_else(|| Ok("null".into()), |record| record.to_json())
    })
}

/// Embed validated workflow JSON in complete XMP, preserving untouched bytes.
/// Reject malformed/future existing metadata. Same return codes and output
/// contract as validation. This function performs no filesystem I/O.
///
/// # Safety
/// Same pointer, length and non-overlap requirements as maple_workflow_validate_json.
#[no_mangle]
pub unsafe extern "C" fn maple_workflow_embed_xmp(
    json: *const u8,
    json_len: usize,
    xmp: *const u8,
    xmp_len: usize,
    out: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    output("maple_workflow_embed_xmp", out, out_cap, out_len, || {
        SidecarWorkflow::parse(input(json, json_len)?)?.embed_in_xmp(input(xmp, xmp_len)?)
    })
}

/// Capture a complete checkpoint by removing only validated owned workflow
/// metadata (#4039). Same return codes and unchanged-on-failure contract.
///
/// # Safety
/// Same pointer, length and non-overlap requirements as maple_workflow_validate_json.
#[no_mangle]
pub unsafe extern "C" fn maple_workflow_checkpoint_xmp(
    xmp: *const u8,
    xmp_len: usize,
    out: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    output(
        "maple_workflow_checkpoint_xmp",
        out,
        out_cap,
        out_len,
        || SidecarWorkflow::checkpoint_xmp(input(xmp, xmp_len)?),
    )
}

/// Resolve a portable UUID sibling beside the primary filename (#4039).
/// This returns a basename, never a filesystem path. Same return codes.
///
/// # Safety
/// Same pointer, length and non-overlap requirements as maple_workflow_validate_json.
#[no_mangle]
pub unsafe extern "C" fn maple_workflow_variant_filename(
    primary_name: *const u8,
    primary_len: usize,
    variant_id: *const u8,
    variant_len: usize,
    out: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    output(
        "maple_workflow_variant_filename",
        out,
        out_cap,
        out_len,
        || {
            raw_core::workflow::variant_filename(
                input(primary_name, primary_len)?,
                input(variant_id, variant_len)?,
            )
        },
    )
}
