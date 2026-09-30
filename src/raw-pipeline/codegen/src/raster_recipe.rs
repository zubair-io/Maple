//! Recipe wire types derived from the actual Rust declarations and serde
//! attributes (#3553). Only the two wire enums and their referenced structs
//! are emitted; no second field inventory is maintained in codegen.

use std::collections::{BTreeMap, BTreeSet};
use syn::{Attribute, Fields, GenericArgument, Item, LitStr, PathArguments, Type};

const SOURCES: [&str; 3] = [
    include_str!("../../raw-core/src/raster_recipe.rs"),
    include_str!("../../raw-core/src/raster_recipe_filter.rs"),
    include_str!("../../raw-core/src/raster_recipe_output.rs"),
];

#[derive(Default)]
struct Serde {
    tag: Option<String>,
    rename: Option<String>,
    rename_all: Option<String>,
    default: bool,
    deny_unknown_fields: bool,
}

fn serde(attrs: &[Attribute]) -> syn::Result<Serde> {
    let mut options = Serde::default();
    for attr in attrs.iter().filter(|attr| attr.path().is_ident("serde")) {
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("deny_unknown_fields") {
                options.deny_unknown_fields = true;
            } else if meta.path.is_ident("default") {
                options.default = true;
                if meta.input.peek(syn::Token![=]) {
                    let _: LitStr = meta.value()?.parse()?;
                }
            } else {
                let slot = if meta.path.is_ident("tag") {
                    &mut options.tag
                } else if meta.path.is_ident("rename") {
                    &mut options.rename
                } else if meta.path.is_ident("rename_all") {
                    &mut options.rename_all
                } else {
                    return Err(meta.error("unsupported recipe serde attribute"));
                };
                *slot = Some(meta.value()?.parse::<LitStr>()?.value());
            }
            Ok(())
        })?;
    }
    Ok(options)
}

fn wire_name(name: &str, options: &Serde) -> String {
    if let Some(rename) = &options.rename {
        return rename.clone();
    }
    match options.rename_all.as_deref() {
        None => name.to_owned(),
        Some("lowercase") => name.to_lowercase(),
        Some("camelCase") => {
            let mut uppercase = false;
            name.chars()
                .enumerate()
                .filter_map(|(i, ch)| {
                    if ch == '_' {
                        uppercase = true;
                        None
                    } else {
                        let renamed = if i == 0 {
                            ch.to_ascii_lowercase()
                        } else if uppercase {
                            ch.to_ascii_uppercase()
                        } else {
                            ch
                        };
                        uppercase = false;
                        Some(renamed)
                    }
                })
                .collect()
        }
        Some(other) => panic!("unsupported recipe rename_all: {other}"),
    }
}

fn ts_type(ty: &Type, references: &mut BTreeSet<String>) -> String {
    match ty {
        Type::Array(array) => {
            let length = match &array.len {
                syn::Expr::Lit(syn::ExprLit {
                    lit: syn::Lit::Int(length),
                    ..
                }) => length.base10_parse::<usize>().expect("recipe tuple length"),
                _ => panic!("unsupported recipe array length"),
            };
            let element = ts_type(&array.elem, references);
            format!("[{}]", vec![element; length].join(", "))
        }
        Type::Path(path) if path.qself.is_none() && path.path.segments.len() == 1 => {
            let segment = &path.path.segments[0];
            let name = segment.ident.to_string();
            match &segment.arguments {
                PathArguments::None => match name.as_str() {
                    "bool" => "boolean".into(),
                    "String" => "string".into(),
                    "u8" | "u16" | "u32" | "usize" | "i64" | "f64" => "number".into(),
                    _ => {
                        references.insert(name.clone());
                        format!("Recipe{name}")
                    }
                },
                PathArguments::AngleBracketed(args) if args.args.len() == 1 => {
                    let Some(GenericArgument::Type(inner)) = args.args.first() else {
                        panic!("unsupported recipe generic argument");
                    };
                    let inner = ts_type(inner, references);
                    match name.as_str() {
                        "Option" => format!("{inner} | null"),
                        "Vec" => format!("Array<{inner}>"),
                        _ => panic!("unsupported recipe container: {name}"),
                    }
                }
                _ => panic!("unsupported recipe type arguments"),
            }
        }
        _ => panic!("unsupported recipe field type"),
    }
}

fn optional(ty: &Type) -> bool {
    matches!(ty, Type::Path(path) if path.path.is_ident("Option")
        || path.path.segments.last().is_some_and(|part| part.ident == "Option"))
}

fn fields(fields: &Fields, rename_all: Option<&str>, refs: &mut BTreeSet<String>) -> Vec<String> {
    let Fields::Named(fields) = fields else {
        panic!("expected named recipe fields");
    };
    fields
        .named
        .iter()
        .map(|field| {
            let options = serde(&field.attrs).expect("recipe field serde attributes");
            let naming = Serde {
                rename: options.rename,
                rename_all: rename_all.map(str::to_owned),
                ..Serde::default()
            };
            let name = wire_name(&field.ident.as_ref().unwrap().to_string(), &naming);
            let suffix = if options.default || optional(&field.ty) {
                "?"
            } else {
                ""
            };
            format!("{name}{suffix}: {}", ts_type(&field.ty, refs))
        })
        .collect()
}

// Match the repository's 100-column TypeScript layout so regeneration is
// deterministic without depending on a JavaScript formatter installation.
fn object(prefix: &str, fields: &[String], indent: usize) -> String {
    let inline = format!("{prefix}{{ {} }}", fields.join("; "));
    if inline.len() < 100 {
        return inline;
    }
    let body = fields
        .iter()
        .map(|field| format!("{}{field};\n", " ".repeat(indent + 2)))
        .collect::<String>();
    format!("{prefix}{{\n{body}{}}}", " ".repeat(indent))
}

fn ts_string(value: &str) -> String {
    format!(
        "'{}'",
        value
            .replace('\\', "\\\\")
            .replace('\'', "\\'")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}

fn emit(sources: &[&str]) -> String {
    let items: BTreeMap<String, Item> = sources
        .iter()
        .flat_map(|source| syn::parse_file(source).expect("recipe Rust source").items)
        .filter_map(|item| {
            let name = match &item {
                Item::Struct(item) => item.ident.to_string(),
                Item::Enum(item) => item.ident.to_string(),
                _ => return None,
            };
            Some((name, item))
        })
        .collect();
    let mut pending = BTreeSet::from(["Op".to_owned(), "Output".to_owned()]);
    let mut done = BTreeSet::new();
    let mut out = "// Generated by tools/codegen.sh from raw-core's raster recipe serde declarations.\n// Do not edit; regenerate when the Rust wire schema changes.\n\n".to_owned();
    while let Some(name) = pending.pop_first() {
        if !done.insert(name.clone()) {
            continue;
        }
        let item = items
            .get(&name)
            .unwrap_or_else(|| panic!("unknown recipe type: {name}"));
        match item {
            Item::Struct(item) => {
                let options = serde(&item.attrs).expect("recipe struct serde attributes");
                assert!(
                    options.deny_unknown_fields,
                    "recipe struct must deny unknown fields"
                );
                let body = fields(&item.fields, options.rename_all.as_deref(), &mut pending);
                out.push_str(&object(&format!("export type Recipe{name} = "), &body, 0));
                out.push_str(";\n\n");
            }
            Item::Enum(item) => {
                let options = serde(&item.attrs).expect("recipe enum serde attributes");
                assert!(
                    options.deny_unknown_fields,
                    "recipe enum must deny unknown fields"
                );
                let tag = options.tag.as_ref().expect("internally tagged recipe enum");
                out.push_str(&format!("export type Recipe{name} =\n"));
                for variant in &item.variants {
                    let variant_options =
                        serde(&variant.attrs).expect("recipe variant serde attributes");
                    let naming = Serde {
                        rename: variant_options.rename,
                        rename_all: options.rename_all.clone(),
                        ..Serde::default()
                    };
                    let value = ts_string(&wire_name(&variant.ident.to_string(), &naming));
                    let body = match &variant.fields {
                        Fields::Named(_) => {
                            let mut body = vec![format!("{tag}: {value}")];
                            body.extend(fields(
                                &variant.fields,
                                variant_options.rename_all.as_deref(),
                                &mut pending,
                            ));
                            object("  | ", &body, 4)
                        }
                        Fields::Unnamed(fields) if fields.unnamed.len() == 1 => {
                            format!(
                                "  | ({{ {tag}: {value} }} & {})",
                                ts_type(&fields.unnamed[0].ty, &mut pending)
                            )
                        }
                        _ => panic!("unsupported recipe variant shape"),
                    };
                    out.push_str(&format!("{body}\n"));
                }
                // Finish on the last variant rather than a separate line.
                out.pop();
                out.push_str(";\n\n");
            }
            _ => unreachable!(),
        }
    }
    out.pop();
    out
}

pub fn emit_ts() -> String {
    emit(&SOURCES)
}

#[cfg(test)]
#[path = "raster_recipe_tests.rs"]
mod tests;
