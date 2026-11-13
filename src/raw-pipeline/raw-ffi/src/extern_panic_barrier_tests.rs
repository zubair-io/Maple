//! CI guard (#4734): every `extern "C" fn` in raw-ffi runs its body behind a
//! panic barrier. A panic unwinding out of an `extern "C"` frame aborts the
//! host (the API server via bun:ffi, the Apple and Windows apps), so an entry
//! is accepted only when its body calls `catch_panic*` / `with_large_stack*`
//! directly, or delegates to a crate function whose every definition does.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

const BARRIERS: [&str; 2] = ["catch_panic", "with_large_stack"];

fn rust_sources(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .flat_map(|path| {
            if path.is_dir() {
                rust_sources(&path)
            } else if path.extension().is_some_and(|ext| ext == "rs")
                && !path.to_string_lossy().ends_with("_tests.rs")
            {
                vec![path]
            } else {
                vec![]
            }
        })
        .collect()
}

/// Byte range of the `{ … }` block opening at or after `from`.
fn block_end(text: &str, open: usize) -> usize {
    let mut depth = 0usize;
    for (offset, byte) in text.as_bytes()[open..].iter().enumerate() {
        match byte {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return open + offset + 1;
                }
            }
            _ => {}
        }
    }
    text.len()
}

/// Source with every `#[cfg(test)] mod … { … }` block removed: test-only
/// `extern "C"` callbacks are not host entry points.
fn without_test_modules(text: &str) -> String {
    let marker = "#[cfg(test)]\nmod ";
    match text.find(marker) {
        None => text.to_string(),
        Some(start) => match text[start..].find(['{', ';']) {
            Some(rel) if text.as_bytes()[start + rel] == b'{' => {
                let end = block_end(text, start + rel);
                format!("{}{}", &text[..start], without_test_modules(&text[end..]))
            }
            _ => format!(
                "{}{}",
                &text[..start + marker.len()],
                without_test_modules(&text[start + marker.len()..])
            ),
        },
    }
}

struct FnDef {
    location: String,
    name: String,
    is_extern_c: bool,
    body: String,
}

fn fn_defs(path: &Path) -> Vec<FnDef> {
    let text = without_test_modules(&std::fs::read_to_string(path).unwrap());
    let file = path.file_name().unwrap().to_string_lossy().into_owned();
    text.match_indices("fn ")
        .filter(|(at, _)| {
            *at == 0
                || !text.as_bytes()[at - 1].is_ascii_alphanumeric()
                    && text.as_bytes()[at - 1] != b'_'
        })
        .filter_map(|(at, _)| {
            let name: String = text[at + 3..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            let after_name = at + 3 + name.len();
            let open = after_name + text[after_name..].find('{')?;
            let semicolon = text[after_name..].find(';').map(|rel| after_name + rel);
            if name.is_empty() || semicolon.is_some_and(|semi| semi < open) {
                return None;
            }
            let body = text[open..block_end(&text, open)].to_string();
            Some(FnDef {
                location: format!("{file}:{}", text[..at].lines().count() + 1),
                is_extern_c: text[..at].trim_end().ends_with("extern \"C\""),
                name,
                body,
            })
        })
        .collect()
}

fn has_barrier(body: &str) -> bool {
    BARRIERS.iter().any(|barrier| body.contains(barrier))
}

#[test]
fn every_extern_c_entry_has_a_panic_barrier() {
    let defs: Vec<FnDef> = rust_sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"))
        .iter()
        .flat_map(|path| fn_defs(path))
        .collect();
    let guarded_helpers: HashMap<&str, bool> = defs.iter().fold(HashMap::new(), |mut acc, def| {
        let guarded = has_barrier(&def.body);
        acc.entry(def.name.as_str())
            .and_modify(|all| *all &= guarded)
            .or_insert(guarded);
        acc
    });
    let delegates_to_guarded = |def: &FnDef| {
        guarded_helpers.iter().any(|(name, &guarded)| {
            guarded && *name != def.name && def.body.contains(&format!("{name}("))
        })
    };

    let externs: Vec<&FnDef> = defs.iter().filter(|def| def.is_extern_c).collect();
    let unguarded: Vec<String> = externs
        .iter()
        .filter(|def| !has_barrier(&def.body) && !delegates_to_guarded(def))
        .map(|def| format!("{} {}", def.location, def.name))
        .collect();

    assert!(
        externs.len() > 100,
        "scanner found only {} extern \"C\" fns",
        externs.len()
    );
    assert!(
        unguarded.is_empty(),
        "extern \"C\" entries without a panic barrier (#4734) — wrap the body in \
         catch_panic_rc / catch_panic / with_large_stack*:\n{}",
        unguarded.join("\n")
    );
}
