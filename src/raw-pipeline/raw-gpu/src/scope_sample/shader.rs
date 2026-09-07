//! Reuse the present quantizer without materializing its noise table in registers.
//!
//! FXC expands dynamic indexing of the 4096-element constant array past its
//! register limit. Only the sampler substitutes a read-only storage declaration;
//! all presentation functions and the actual presentation shader stay unchanged.

const NOISE_DECLARATION: &str = "const BLUE_NOISE_64X64: array<u32, 4096> = array<u32, 4096>(";
const NOISE_STORAGE: &str =
    "@group(0) @binding(3) var<storage, read> BLUE_NOISE_64X64: array<u32, 4096>;";

/// Extract the existing shader's table once, avoiding a new mirrored constant or
/// a production dependency on raw-core (which already optionally uses raw-gpu).
/// The tests compare every cell against raw-core's canonical u16 table.
pub(super) fn compose(present: &str) -> Result<(String, Vec<u32>), String> {
    if present.matches(NOISE_DECLARATION).count() != 1 {
        return Err("scope sample: expected exactly one present blue-noise declaration".into());
    }
    let (before, declaration) = present.split_once(NOISE_DECLARATION).unwrap();
    let (literals, after) = declaration
        .split_once(");")
        .ok_or("scope sample: unterminated present blue-noise declaration")?;
    let literals = literals.trim();
    let literals = literals.strip_suffix(',').unwrap_or(literals);
    let noise = literals
        .split(',')
        .map(|literal| {
            literal
                .trim()
                .strip_suffix('u')
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|value| *value < 4096)
                .ok_or_else(|| "scope sample: invalid present blue-noise cell".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if noise.len() != 4096 {
        return Err("scope sample: expected 4096 present blue-noise cells".into());
    }
    Ok((
        format!(
            "{before}{NOISE_STORAGE}{after}\n{}",
            include_str!("../scope_sample.wgsl")
        ),
        noise,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRESENT: &str = include_str!("../present_chain.wgsl");

    #[test]
    fn storage_noise_matches_canonical_cells_and_preserves_present_functions() {
        let (source, noise) = compose(PRESENT).expect("present shader shape");
        assert_eq!(
            noise,
            raw_core::view::dither::BLUE_NOISE_64X64.map(u32::from)
        );
        assert!(!source.contains(NOISE_DECLARATION));
        assert_eq!(source.matches(NOISE_STORAGE).count(), 1);
        // Everything after the original table, including the noise lookup and
        // quantizer, must survive byte-for-byte before the sampler is appended.
        let (_, declaration) = PRESENT.split_once(NOISE_DECLARATION).unwrap();
        let (_, functions) = declaration.split_once(");").unwrap();
        assert!(source.ends_with(&format!(
            "{functions}\n{}",
            include_str!("../scope_sample.wgsl")
        )));
    }

    #[test]
    fn unexpected_present_table_shape_fails_loudly() {
        for source in [
            PRESENT.replace(NOISE_DECLARATION, "const DIFFERENT_TABLE = ("),
            format!("{PRESENT}\n{PRESENT}"),
            format!("{NOISE_DECLARATION}0u);"),
            format!("{NOISE_DECLARATION}0u"),
            PRESENT.replacen("227u,", "invalidu,", 1),
            PRESENT.replacen("227u,", "4096u,", 1),
        ] {
            assert!(compose(&source).is_err());
        }
    }
}
