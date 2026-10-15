//! Small well-formedness guards omitted by quick-xml's streaming tokenizer.
use crate::error::{Error, Result};
use quick_xml::events::{BytesDecl, BytesStart};

fn xml_char(value: u32) -> bool {
    matches!(value, 0x9 | 0xa | 0xd | 0x20..=0xd7ff | 0xe000..=0xfffd | 0x10000..=0x10ffff)
}

// XML 1.0 NCName ranges: https://www.w3.org/TR/xml/#NT-NameStartChar
fn name_start(c: char) -> bool {
    matches!(c, '_' | 'A'..='Z' | 'a'..='z')
        || matches!(c as u32, 0xc0..=0xd6 | 0xd8..=0xf6 | 0xf8..=0x2ff
            | 0x370..=0x37d | 0x37f..=0x1fff | 0x200c..=0x200d | 0x2070..=0x218f
            | 0x2c00..=0x2fef | 0x3001..=0xd7ff | 0xf900..=0xfdcf
            | 0xfdf0..=0xfffd | 0x10000..=0xeffff)
}

fn name_part(part: &str) -> bool {
    let mut chars = part.chars();
    chars.next().is_some_and(name_start) && chars.all(name_continue)
}

fn name_continue(c: char) -> bool {
    name_start(c)
        || matches!(c, '-' | '.' | '0'..='9' | '\u{b7}' | '\u{300}'..='\u{36f}' | '\u{203f}'..='\u{2040}')
}

pub(super) fn qualified_name(value: &[u8]) -> Result<()> {
    let name = std::str::from_utf8(value).map_err(|error| Error::Xmp(error.to_string()))?;
    let mut parts = name.split(':');
    if !parts.next().is_some_and(name_part)
        || parts.next().is_some_and(|part| !name_part(part))
        || parts.next().is_some()
    {
        return Err(Error::Xmp("Invalid XML qualified name".into()));
    }
    Ok(())
}

pub(super) fn instruction_name(value: &[u8]) -> Result<()> {
    // PI targets are XML Names, not namespace-qualified names.
    let name = std::str::from_utf8(value).map_err(|error| Error::Xmp(error.to_string()))?;
    let mut chars = name.chars();
    if !chars.next().is_some_and(|c| name_start(c) || c == ':')
        || !chars.all(|c| name_continue(c) || c == ':')
    {
        return Err(Error::Xmp("Invalid XML instruction name".into()));
    }
    Ok(())
}

pub(super) fn xml_declaration(declaration: &BytesDecl<'_>) -> Result<()> {
    let text = std::str::from_utf8(declaration).map_err(|error| Error::Xmp(error.to_string()))?;
    let element = BytesStart::from_content(text, 3);
    let mut position = 0;
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|error| Error::Xmp(error.to_string()))?;
        let next = match attribute.key.as_ref() {
            b"version" if matches!(attribute.value.as_ref(), b"1.0" | b"1.1") => 1,
            b"encoding"
                if attribute.value.first().is_some_and(u8::is_ascii_alphabetic)
                    && attribute
                        .value
                        .iter()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(b)) =>
            {
                2
            }
            b"standalone" if matches!(attribute.value.as_ref(), b"yes" | b"no") => 3,
            _ => return Err(Error::Xmp("Invalid XML declaration".into())),
        };
        if next <= position || (position == 0 && next != 1) {
            return Err(Error::Xmp("Invalid XML declaration order".into()));
        }
        position = next;
    }
    if position == 0 {
        return Err(Error::Xmp("Missing XML version".into()));
    }
    Ok(())
}

// Validate opaque XML without unescaping/copying it. DTD entities are forbidden.
pub(super) fn validate(value: &[u8], escaped: bool) -> Result<()> {
    let text = std::str::from_utf8(value).map_err(|error| Error::Xmp(error.to_string()))?;
    if text.chars().any(|c| !xml_char(c as u32)) {
        return Err(Error::Xmp("Invalid XML character".into()));
    }
    if !escaped {
        return Ok(());
    }
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        let tail = &rest[at + 1..];
        let end = tail
            .find(';')
            .ok_or_else(|| Error::Xmp("Unclosed XML entity".into()))?;
        let entity = &tail[..end];
        let valid = matches!(entity, "amp" | "lt" | "gt" | "apos" | "quot")
            || entity
                .strip_prefix("#x")
                .and_then(|v| {
                    v.bytes()
                        .all(|b| b.is_ascii_hexdigit())
                        .then(|| u32::from_str_radix(v, 16).ok())
                        .flatten()
                })
                .is_some_and(xml_char)
            || entity
                .strip_prefix('#')
                .and_then(|v| {
                    v.bytes()
                        .all(|b| b.is_ascii_digit())
                        .then(|| v.parse::<u32>().ok())
                        .flatten()
                })
                .is_some_and(xml_char);
        if !valid {
            return Err(Error::Xmp("Invalid XML entity".into()));
        }
        rest = &tail[end + 1..];
    }
    Ok(())
}
