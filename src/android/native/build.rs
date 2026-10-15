#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../raw-pipeline/raw-core/src/film_catalog.rs"]
mod catalog;

fn main() {
    let root = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../../resources/film-luts");
    let mut source = String::from("const FILMS: &[(&str, &[u8])] = &[\n");
    for entry in catalog::FILM_CATALOG {
        let path = root
            .join(format!("{}.mlut", entry.id))
            .canonicalize()
            .expect("shared film resource");
        println!("cargo:rerun-if-changed={}", path.display());
        source.push_str(&format!("({:?}, include_bytes!({:?})),\n", entry.id, path));
    }
    println!("cargo:rerun-if-changed=../../raw-pipeline/raw-core/src/film_catalog.rs");
    source.push_str("];\n");
    std::fs::write(
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("films.rs"),
        source,
    )
    .unwrap();
}
