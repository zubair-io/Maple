//! Minimal, dependency-free EXIF date parsing + a strftime-style formatter
//! for the `{date:FORMAT}` filename-template token (#2628).
//!
//! `raw-core` carries no chrono/time dependency, and this module doesn't add
//! one: it also compiles to `wasm32` for the browser, and the only date
//! shape it ever needs to read is EXIF `DateTimeOriginal`'s fixed
//! `"YYYY:MM:DD HH:MM:SS"` layout (`crate::api::Exif::captured_at`'s
//! documented format — see that field's doc comment). A hand-rolled parser
//! for exactly that one shape is a few dozen lines instead of a dependency
//! pulled into every platform's binary for one feature.

/// A parsed EXIF capture timestamp. Deliberately NOT validated against the
/// real calendar (a month of `13` or a day of `31` in April both parse
/// successfully) — this module only ever formats the value back out as
/// decimal digits, never does date arithmetic, so an implausible calendar
/// date can't produce a *wrong* answer, only an unusual-looking (but still
/// deterministic) filename. Camera clocks are also not infrequently wrong in
/// exactly this way (never-set date = `2002:01:01`, etc.), and silently
/// falling back to [`FALLBACK_DATE_TEXT`] for those would hide real EXIF
/// data behind a formatting opinion this module has no business holding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExifDateTime {
    pub year: u32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// Parse EXIF `DateTimeOriginal`'s canonical `"YYYY:MM:DD HH:MM:SS"` string
/// (exactly 19 ASCII bytes: 4 digits, `:`, 2 digits, `:`, 2 digits, ` `, 2
/// digits, `:`, 2 digits, `:`, 2 digits). Returns `None` for anything that
/// doesn't match that exact shape — this is the "unparseable" half of
/// [`super::render_filename`]'s documented missing/unparseable-date
/// fallback: a malformed string is treated exactly like a missing one,
/// never a panic.
pub(crate) fn parse_exif_datetime(s: &str) -> Option<ExifDateTime> {
    let b = s.as_bytes();
    if b.len() != 19 {
        return None;
    }
    if b[4] != b':' || b[7] != b':' || b[10] != b' ' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let digit = |i: usize| -> Option<u32> {
        b.get(i)
            .filter(|c| c.is_ascii_digit())
            .map(|c| (c - b'0') as u32)
    };
    let two = |i: usize| -> Option<u32> { Some(digit(i)? * 10 + digit(i + 1)?) };

    let year = two(0)?.checked_mul(100)?.checked_add(two(2)?)?;
    let month = two(5)?;
    let day = two(8)?;
    let hour = two(11)?;
    let minute = two(14)?;
    let second = two(17)?;
    Some(ExifDateTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
    })
}

/// Fallback text substituted for `{date:FORMAT}` when
/// [`super::RenderInputs::captured_at`] is missing or fails to parse.
/// Chosen over an empty string so a batch-rename preview makes the gap
/// visible instead of silently collapsing adjacent literal separators —
/// e.g. `"{date:%Y}-{n}"` on a dateless file renders `"unknown-date-1"`, not
/// the potentially confusing `"-1"`. This string itself always passes
/// [`super::validate_filename`] (no separators, no leading dot, not
/// reserved), so it never turns an otherwise-valid template invalid on its
/// own.
pub(crate) const FALLBACK_DATE_TEXT: &str = "unknown-date";

/// Render `dt` per a strftime-style `format` string.
///
/// Supported directives: `%Y` (4-digit year), `%y` (2-digit year, `year %
/// 100`), `%m`/`%d`/`%H`/`%M`/`%S` (zero-padded 2-digit month/day/24-hour/
/// minute/second), `%%` (literal `%`).
///
/// Any other `%x` sequence — including a lone trailing `%` with nothing
/// after it — is copied through verbatim rather than erroring. The
/// directive set a UI offers is closed (a fixed insert-token control, not
/// free-form typing of directive letters), so an unrecognised directive can
/// only reach this function via a future format the UI hasn't caught up to
/// yet; printing it back unchanged is more useful for spotting that gap
/// than silently dropping it, and — per the module's pure/no-panic
/// contract — it must not be a hard error for a batch-rename preview that
/// is otherwise valid.
pub(crate) fn format_strftime(format: &str, dt: &ExifDateTime) -> String {
    let mut out = String::with_capacity(format.len());
    let mut chars = format.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('Y') => out.push_str(&format!("{:04}", dt.year)),
            Some('y') => out.push_str(&format!("{:02}", dt.year % 100)),
            Some('m') => out.push_str(&format!("{:02}", dt.month)),
            Some('d') => out.push_str(&format!("{:02}", dt.day)),
            Some('H') => out.push_str(&format!("{:02}", dt.hour)),
            Some('M') => out.push_str(&format!("{:02}", dt.minute)),
            Some('S') => out.push_str(&format!("{:02}", dt.second)),
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}
