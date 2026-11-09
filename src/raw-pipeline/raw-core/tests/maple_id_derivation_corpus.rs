//! The cross-client derivation corpus (#5079): each file's primary form is
//! hashed from the capture date the server's `readExif` produced (no date
//! selects the fallback form). Cases marked `optional` name gitignored RAWs and
//! are skipped when absent. Pinned by `tests/maple-id-contract.test.ts`,
//! `MapleIdDerivationContractTests` and the web contract spec too.

use raw_core::MapleId;
use std::io::Read;

#[test]
fn derivation_corpus_matches_the_server() {
    let ids = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/ids");
    let corpus: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(ids.join("derivation.json")).unwrap())
            .unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let file = case["file"].as_str().unwrap();
        let path = ids.join(file);
        if case["optional"].as_bool() == Some(true) && !path.exists() {
            continue;
        }
        let id = match case["capturedAt"].as_str() {
            Some(captured_at) => {
                // The primary form hashes only the first 64 KB.
                let mut head = Vec::new();
                std::fs::File::open(&path)
                    .unwrap()
                    .take(raw_core::id::SHA1_HEAD_BYTES as u64)
                    .read_to_end(&mut head)
                    .unwrap();
                MapleId::primary(&head, captured_at, None, None)
            }
            None => {
                let bytes = std::fs::read(&path).unwrap();
                MapleId::fallback(&bytes, bytes.len() as u64)
            }
        };
        assert_eq!(id.to_hex(), case["id"].as_str().unwrap(), "{file}");
    }
}
