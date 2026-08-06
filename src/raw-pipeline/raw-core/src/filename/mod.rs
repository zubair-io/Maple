//! Batch-rename filename-template engine (#2628, Milestone 23 · File
//! Management, Group 0 foundation).
//!
//! Three surfaces (Apple, Web, Windows) plus the Self Hosted API all need to
//! turn a user-authored template like `"{original}_{n}.{ext}"` into a
//! concrete filename per source file. Three hand-written parsers would
//! drift, and the drift would be user-visible: the same template over the
//! same files producing different names on different machines. This module
//! is the one implementation; `raw-ffi` (Apple C-FFI + Windows P/Invoke over
//! the same C ABI) and `raw-wasm` (Web) are thin marshalling shims over it.
//!
//! **Pure function, no platform deps.** No filesystem access, no clock
//! read, no RNG — [`render_filename`] and [`validate_filename`] are
//! deterministic functions of their arguments alone, callable identically
//! from native Rust, wasm32, and (via the C ABI) Swift and C#.
//!
//! **Tokens:** `{original}` (source stem, no extension), `{n}` (sequence
//! number — see [`SequenceOptions`]), `{date:FORMAT}` (EXIF
//! `DateTimeOriginal`, strftime-style — see [`date::format_strftime`] for
//! the supported directives and [`date::FALLBACK_DATE_TEXT`] for the
//! missing/unparseable-date behaviour), `{ext}` (source extension, no
//! leading dot), and literal text for everything outside `{...}`.
//!
//! **Validation.** The engine enforces the *strictest* platform's naming
//! rules on every platform — Windows' reserved device names, trailing
//! dot/space, and both path separators — even on macOS/Linux/Web, because a
//! template is typically authored once and reused across a whole library
//! that may later be opened on any OS. See [`validate_filename`] for the
//! exact rule set. [`SequenceOptions::pad_width`] is bounded by
//! [`MAX_SEQUENCE_PAD_WIDTH`] for the same reason a caller-controlled
//! allocation size is always bounded on a surface reachable from FFI/WASM/
//! the Self Hosted API — see that constant's doc.

mod date;

use date::{format_strftime, parse_exif_datetime, FALLBACK_DATE_TEXT};

/// Per-render inputs describing exactly one output filename. Everything
/// here is caller-resolved: this module does no EXIF extraction of its own
/// (`captured_at` is already-extracted text, not a RAW byte slice) and no
/// batch bookkeeping (`index` is the caller's loop counter, not something
/// this module tracks across calls).
#[derive(Debug, Clone, Copy)]
pub struct RenderInputs<'a> {
    /// Source filename stem, without extension (`{original}`).
    pub original_stem: &'a str,
    /// Source file extension, without the leading dot (`{ext}`).
    pub ext: &'a str,
    /// Zero-based position of this file within its batch. Combined with
    /// [`SequenceOptions::start`] to produce `{n}`'s value:
    /// `start + index`.
    pub index: u64,
    /// EXIF `DateTimeOriginal`, verbatim in its EXIF wire format
    /// (`"YYYY:MM:DD HH:MM:SS"` — matches `crate::api::Exif::captured_at`'s
    /// documented shape). `None`, or a string that doesn't parse in that
    /// exact shape, renders every `{date:FORMAT}` token as
    /// [`date::FALLBACK_DATE_TEXT`] instead of failing the whole render —
    /// a batch rename over a mixed folder (some files with EXIF dates, some
    /// without) should still produce names for every file.
    pub captured_at: Option<&'a str>,
}

/// Batch-level sequence-number configuration, shared by every file in one
/// rename batch (`{n}`).
#[derive(Debug, Clone, Copy)]
pub struct SequenceOptions {
    /// The value `{n}` takes when [`RenderInputs::index`] is `0`; later
    /// files are `start + index`.
    pub start: u64,
    /// Minimum digit width; shorter numbers are left-padded with `'0'`. `0`
    /// means no padding. A number wider than `pad_width` is never
    /// truncated — `pad_width` is a floor, not a cap (matches every real
    /// batch-rename tool: padding exists so `9` sorts before `10`, not to
    /// silently lose digits once a sequence grows past the configured
    /// width). Must not exceed [`MAX_SEQUENCE_PAD_WIDTH`]; [`render_filename`]
    /// rejects a larger value with
    /// [`FilenameError::SequencePadWidthTooLarge`] rather than performing the
    /// (potentially huge) allocation `format!("{:0width$}", ...)` would need.
    pub pad_width: usize,
}

/// Upper bound on [`SequenceOptions::pad_width`].
///
/// This engine is reachable from FFI, WASM, and (via the Self Hosted API)
/// a remote HTTP caller — `pad_width` flows straight into
/// `format!("{:0width$}", n, width = pad_width)`, so an unbounded caller-
/// supplied width is a memory-exhaustion vector: a `pad_width` in the
/// millions forces a multi-megabyte-or-larger allocation per rendered name,
/// and a batch of such calls can OOM the process on a surface where that is
/// remotely triggerable. No real filename ever needs more than a handful of
/// zero-padding digits — a six-figure photo sequence is `999999`, six
/// digits — so `32` is enormously generous headroom past any legitimate use
/// while keeping the worst-case allocation trivially small. Rejected
/// outright rather than silently clamped, matching this module's existing
/// stance of never silently altering caller intent (see `pad_width`'s own
/// doc: it never truncates a wider number either).
pub const MAX_SEQUENCE_PAD_WIDTH: usize = 32;

/// Everything that can go wrong rendering or validating a filename.
///
/// Split from the crate-wide [`crate::Error`] deliberately: every other
/// `raw-core` fallible path funnels into that single enum because its
/// callers only ever need a human-readable message. This module's callers
/// are different — an interactive batch-rename preview needs to
/// discriminate *why* a specific candidate name is invalid (reserved name?
/// leading dot? a bad template?) to show a useful inline error, without
/// string-matching a message. [`FilenameError::kind`] gives each variant a
/// stable snake_case tag for exactly that; the golden fixture corpus at
/// `test-fixtures/filename-templates/cases.json` references these tags
/// directly so the cross-surface parity harness (#2633) can assert the same
/// rejection *reason* on every platform, not just the same yes/no outcome.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FilenameError {
    /// A template `{` was never closed with a matching `}`. `at` is the
    /// byte offset of the unmatched `{`.
    #[error("template has an unterminated '{{' starting at byte {at}")]
    UnterminatedToken { at: usize },
    /// A `{...}` block's contents don't match any recognised token
    /// (`original`, `n`, `ext`, or a `date:` prefix). Carries the raw
    /// contents between the braces.
    #[error("unknown template token {{{0}}}")]
    UnknownToken(String),
    /// The rendered filename is the empty string.
    #[error("rendered filename is empty")]
    Empty,
    /// The rendered filename contains `/` or `\`, checked regardless of
    /// host OS — see [`validate_filename`].
    #[error("filename {0:?} contains a path separator")]
    PathSeparator(String),
    /// The rendered filename starts with `.`.
    #[error("filename {0:?} starts with a leading dot")]
    LeadingDot(String),
    /// The rendered filename ends with `.` or a space.
    #[error("filename {0:?} ends with a trailing dot or space")]
    TrailingDotOrSpace(String),
    /// The rendered filename's stem (the portion before its first `.`)
    /// case-insensitively matches a Windows-reserved device name.
    #[error("filename {0:?} is an OS-reserved device name")]
    ReservedName(String),
    /// [`SequenceOptions::pad_width`] exceeds [`MAX_SEQUENCE_PAD_WIDTH`] —
    /// see that constant's doc for why this is rejected outright rather than
    /// silently clamped (a memory-DoS vector on remotely-triggerable
    /// surfaces).
    #[error("sequence pad_width {pad_width} exceeds the maximum of {max}")]
    SequencePadWidthTooLarge { pad_width: usize, max: usize },
}

impl FilenameError {
    /// Stable snake_case discriminant, independent of the human-readable
    /// message text. Used by `raw-ffi`'s numeric error codes, by JS callers
    /// of `raw-wasm` that want to switch on rejection reason without
    /// parsing a message string, and by the golden fixture corpus's
    /// `"error"` field.
    pub fn kind(&self) -> &'static str {
        match self {
            FilenameError::UnterminatedToken { .. } => "unterminated_token",
            FilenameError::UnknownToken(_) => "unknown_token",
            FilenameError::Empty => "empty",
            FilenameError::PathSeparator(_) => "path_separator",
            FilenameError::LeadingDot(_) => "leading_dot",
            FilenameError::TrailingDotOrSpace(_) => "trailing_dot_or_space",
            FilenameError::ReservedName(_) => "reserved_name",
            FilenameError::SequencePadWidthTooLarge { .. } => "sequence_pad_width_too_large",
        }
    }
}

/// Result alias for this module's fallible entries.
pub type FilenameResult<T> = std::result::Result<T, FilenameError>;

/// Windows device names reserved regardless of extension, case-insensitive
/// (ticket #2628's acceptance criteria — the DOS/Win32 reserved-name list).
/// The engine is shared by all three OSes, so it enforces the *strictest*
/// platform's rules everywhere: a template producing `CON.dng` is rejected
/// on macOS too, rather than working there and silently breaking only for a
/// Windows user who opens the same library later.
const RESERVED_WINDOWS_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Literal(String),
    Original,
    Sequence,
    Ext,
    Date(String),
}

/// Split a template into tokens.
///
/// `{original}`, `{n}`, `{ext}` are exact matches; `{date:FORMAT}` accepts
/// any `FORMAT` (including empty, which — for a file with a parseable date
/// — renders zero characters; a dateless file still renders
/// [`date::FALLBACK_DATE_TEXT`] regardless of `FORMAT`). Everything outside
/// `{...}` is literal text, copied through unchanged — including a bare `}`
/// with no matching `{`, which is not itself a token delimiter.
///
/// There is no escape sequence for a literal `{` or `}` in this version:
/// every token name is a fixed, closed set a UI inserts via a button or
/// dropdown, not something a user free-types around, so no real caller
/// needs one yet (YAGNI) — add one if that stops being true rather than
/// speculatively now.
fn parse_template(template: &str) -> FilenameResult<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut literal_start = 0usize;
    let mut i = 0usize;
    let bytes = template.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if i > literal_start {
                tokens.push(Token::Literal(template[literal_start..i].to_string()));
            }
            let Some(rel_close) = template[i..].find('}') else {
                return Err(FilenameError::UnterminatedToken { at: i });
            };
            let close = i + rel_close;
            let body = &template[i + 1..close];
            let token = match body {
                "original" => Token::Original,
                "n" => Token::Sequence,
                "ext" => Token::Ext,
                _ if body.starts_with("date:") => Token::Date(body["date:".len()..].to_string()),
                other => return Err(FilenameError::UnknownToken(other.to_string())),
            };
            tokens.push(token);
            i = close + 1;
            literal_start = i;
        } else {
            i += 1;
        }
    }
    if literal_start < bytes.len() {
        tokens.push(Token::Literal(template[literal_start..].to_string()));
    }
    Ok(tokens)
}

/// Render one filename from a batch-rename `template`, for one file's
/// [`RenderInputs`] under one batch's [`SequenceOptions`].
///
/// The rendered string is checked with [`validate_filename`] before being
/// returned — a template that would produce a path separator or an
/// OS-reserved name is rejected here, not silently written to disk by a
/// caller that assumed engine output is always safe.
pub fn render_filename(
    template: &str,
    inputs: &RenderInputs<'_>,
    sequence: &SequenceOptions,
) -> FilenameResult<String> {
    if sequence.pad_width > MAX_SEQUENCE_PAD_WIDTH {
        return Err(FilenameError::SequencePadWidthTooLarge {
            pad_width: sequence.pad_width,
            max: MAX_SEQUENCE_PAD_WIDTH,
        });
    }
    let tokens = parse_template(template)?;
    let mut out = String::new();
    for token in &tokens {
        match token {
            Token::Literal(s) => out.push_str(s),
            Token::Original => out.push_str(inputs.original_stem),
            Token::Ext => out.push_str(inputs.ext),
            Token::Sequence => {
                let n = sequence.start.saturating_add(inputs.index);
                out.push_str(&format!("{:0width$}", n, width = sequence.pad_width));
            }
            Token::Date(format) => {
                let text = match inputs.captured_at.and_then(parse_exif_datetime) {
                    Some(dt) => format_strftime(format, &dt),
                    None => FALLBACK_DATE_TEXT.to_string(),
                };
                out.push_str(&text);
            }
        }
    }
    validate_filename(&out)?;
    Ok(out)
}

/// Validate a filename against the same rules [`render_filename`] enforces
/// on its output. Exposed standalone so a manually-typed single-file rename
/// (no template involved — the inline-rename tickets #2637-#2639) gets
/// byte-identical rejection behaviour to a templated batch rename, on every
/// platform: the whole reason this validation lives in `raw-core` rather
/// than being reimplemented per surface.
///
/// Rejects, in this order:
/// 1. An empty string ([`FilenameError::Empty`]).
/// 2. A path separator, `/` or `\` — both are checked regardless of host OS
///    ([`FilenameError::PathSeparator`]): a template authored on macOS must
///    not produce a name that only breaks once the same library is opened
///    on Windows.
/// 3. A leading `.` ([`FilenameError::LeadingDot`]).
/// 4. A trailing `.` or trailing space ([`FilenameError::TrailingDotOrSpace`],
///    a Windows restriction applied everywhere for the same cross-platform
///    reason as separators).
/// 5. A Windows-reserved device name — `CON`, `PRN`, `AUX`, `NUL`,
///    `COM1`-`COM9`, `LPT1`-`LPT9` — matched case-insensitively against the
///    name's stem (the portion before its *first* `.`), so `Con.dng` and
///    `con.tar.gz` are both rejected exactly as bare `CON` would be
///    ([`FilenameError::ReservedName`]). A name like `Console.dng`, whose
///    stem is `Console` (not an exact reserved-name match), is accepted.
pub fn validate_filename(name: &str) -> FilenameResult<()> {
    if name.is_empty() {
        return Err(FilenameError::Empty);
    }
    if name.contains('/') || name.contains('\\') {
        return Err(FilenameError::PathSeparator(name.to_string()));
    }
    if name.starts_with('.') {
        return Err(FilenameError::LeadingDot(name.to_string()));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(FilenameError::TrailingDotOrSpace(name.to_string()));
    }
    let stem = name.split('.').next().unwrap_or(name);
    let stem_upper = stem.to_ascii_uppercase();
    if RESERVED_WINDOWS_NAMES.contains(&stem_upper.as_str()) {
        return Err(FilenameError::ReservedName(name.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_date;
#[cfg(test)]
mod tests_fixtures;
#[cfg(test)]
mod tests_validation;
