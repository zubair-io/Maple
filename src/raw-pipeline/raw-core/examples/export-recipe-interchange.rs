//! Real cross-language recipe acceptance (#4207); emit and verify semantic artifacts.
use raw_core::export_recipe::{ExportRecipe, RECIPE_FIELDS};
use serde_json::{json, Value};
use std::{collections::BTreeSet, error::Error, fs, path::Path};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn ensure(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn read(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn write(path: &Path, value: &Value) -> Result<()> {
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}
fn entries<'a>(value: &'a Value, key: &str, count: usize) -> Result<&'a Vec<Value>> {
    let result = value[key].as_array().ok_or("missing artifact array")?;
    ensure(result.len() == count, "incorrect artifact case count")?;
    let ids: BTreeSet<_> = result.iter().map(|v| v["id"].as_str()).collect();
    ensure(
        ids.len() == count && !ids.contains(&None),
        "invalid or repeated case ID",
    )?;
    Ok(result)
}
fn emit(out: &Path, manifest: &Path) -> Result<()> {
    let matrix = read(manifest)?;
    let semantic = entries(&matrix, "semantic", 20)?;
    let malformed = entries(&matrix, "malformed", 8)?;
    let mut emitted = Vec::new();
    for case in semantic {
        let mut value = serde_json::to_value(ExportRecipe::default())?;
        value["name"] = case["id"].clone();
        for (key, field) in case["fields"]
            .as_object()
            .ok_or("missing field mutations")?
        {
            ensure(
                value.get(key).is_some(),
                "manifest introduces unknown schema field",
            )?;
            value[key] = field.clone();
        }
        let recipe = ExportRecipe::parse(&value.to_string())?;
        let supported = case["supported"]
            .as_bool()
            .ok_or("missing admission expectation")?;
        let admission = recipe.validate();
        ensure(
            admission.is_ok() == supported,
            "Rust admission disagrees with frozen manifest",
        )?;
        emitted.push(json!({"id":case["id"], "supported":supported,
            "recipe":serde_json::to_value(recipe)?, "admissionError":admission.err()}));
    }
    ensure(
        emitted.iter().filter(|v| v["supported"] == true).count() == 7,
        "supported inventory changed",
    )?;
    let mut rejected = Vec::new();
    for case in malformed {
        let mut value = serde_json::to_value(ExportRecipe::default())?;
        let field = case["field"].as_str().ok_or("malformed field absent")?;
        match case["operation"].as_str() {
            Some("remove") => {
                value.as_object_mut().unwrap().remove(field);
            }
            Some("set") => {
                value[field] = case["value"].clone();
            }
            _ => return Err("unknown malformed operation".into()),
        }
        ensure(
            ExportRecipe::parse(&value.to_string()).is_err(),
            "Rust accepted malformed recipe",
        )?;
        rejected.push(json!({"id":case["id"],"value":value}));
    }
    fs::create_dir_all(out)?;
    write(
        &out.join("rust.json"),
        &json!({"semantic":emitted,"malformed":rejected}),
    )
}
fn verify(out: &Path) -> Result<()> {
    let original = read(&out.join("rust.json"))?;
    let expected = entries(&original, "semantic", 20)?;
    let invalid = entries(&original, "malformed", 8)?;
    let mut legs = Vec::new();
    for leg in ["swift", "browser"] {
        let artifact = read(&out.join(format!("{leg}.json")))?;
        let actual = entries(&artifact, "semantic", 20)?;
        let rejected = entries(&artifact, "malformed", 8)?;
        for reference in expected {
            let case = actual
                .iter()
                .find(|v| v["id"] == reference["id"])
                .ok_or("lost semantic case")?;
            let recipe = ExportRecipe::parse(&case["recipe"].to_string())?;
            let original_recipe = ExportRecipe::parse(&reference["recipe"].to_string())?;
            ensure(
                recipe == original_recipe,
                "cross-language semantic field changed",
            )?;
            // Value equality pins explicit nulls and the entire declared key set.
            ensure(
                case["recipe"] == reference["recipe"],
                "wire keys or explicit nulls changed",
            )?;
            ensure(
                case["recipe"].as_object().unwrap().len() == RECIPE_FIELDS.len(),
                "field inventory mismatch",
            )?;
            let supported = reference["supported"].as_bool().unwrap();
            ensure(
                case["supported"] == reference["supported"],
                "admission expectation changed",
            )?;
            ensure(
                recipe.validate().is_ok() == supported,
                "returned Rust admission changed",
            )?;
            ensure(
                case["accepted"].as_bool() == Some(supported),
                "platform admission mismatch",
            )?;
            if !supported {
                ensure(
                    case["admissionError"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty()),
                    "unsupported execution admission lacks error",
                )?;
            }
        }
        for reference in invalid {
            let case = rejected
                .iter()
                .find(|v| v["id"] == reference["id"])
                .ok_or("lost malformed case")?;
            ensure(
                case["rejected"] == true,
                "platform accepted malformed recipe",
            )?;
            ensure(
                case["error"].as_str().is_some_and(|s| !s.is_empty()),
                "malformed rejection lacks error",
            )?;
        }
        legs.push(
            json!({"leg":leg,"semantic":20,"supported":7,"unsupported":13,"malformedRejected":8}),
        );
    }
    write(
        &out.join("result.json"),
        &json!({"fourLegCases":20,"rustMalformedRejected":8,"fieldCount":RECIPE_FIELDS.len(),"legs":legs}),
    )?;
    println!("Recipe interchange PASS: 20 four-leg cases, 7 supported/13 unsupported, 8 malformed per decoder");
    Ok(())
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("emit") if args.len() == 4 => emit(Path::new(&args[2]), Path::new(&args[3])),
        Some("verify") if args.len() == 3 => verify(Path::new(&args[2])),
        _ => Err("usage: export-recipe-interchange emit OUT MANIFEST | verify OUT".into()),
    }
}
