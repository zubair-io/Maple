// The build needs catalog IDs; names/categories are consumed by the runtime UI.
#[rustfmt::skip]
#[allow(dead_code)]
#[path = "../raw-pipeline/raw-core/src/film_catalog.rs"]
mod catalog;

fn main() {
    let root = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../resources/film-luts");
    println!("cargo:rerun-if-changed=../raw-pipeline/raw-core/src/film_catalog.rs");
    let mut source = String::from("const BUNDLED: &[(&str, &[u8])] = &[\n");
    for entry in catalog::FILM_CATALOG {
        let path = root
            .join(format!("{}.mlut", entry.id))
            .canonicalize()
            .expect("complete shared film resource pack");
        assert!(
            path.metadata().unwrap().len() <= 16 * 1024 * 1024,
            "film resource size limit"
        );
        println!("cargo:rerun-if-changed={}", path.display());
        source.push_str(&format!("({:?}, include_bytes!({:?})),\n", entry.id, path));
    }
    source.push_str("];\n");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    std::fs::write(output.join("film_resources.rs"), source).unwrap();
}
