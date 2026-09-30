use super::*;

#[test]
fn follows_serde_defaults_names_and_nested_shapes() {
    let source = r#"
        #[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
        enum Op {
            #[serde(rename_all = "camelCase")]
            TestCase { required_value: u32, #[serde(default)] default_value: bool,
                       maybe: Option<[u8; 3]>, children: Vec<Child> },
            #[serde(rename = "explicit")]
            Nested(Child),
        }
        #[serde(deny_unknown_fields)]
        struct Child { #[serde(rename = "wireName")] name: String }
        #[serde(tag = "format", rename_all = "lowercase", deny_unknown_fields)]
        enum Output { Raw {} }
    "#;
    let ts = emit(&[source]);
    assert!(ts.contains("requiredValue: number;"));
    assert!(ts.contains("defaultValue?: boolean;"));
    assert!(ts.contains("maybe?: [number, number, number] | null;"));
    assert!(ts.contains("children: Array<RecipeChild>;"));
    assert!(ts.contains("wireName: string"));
    assert!(ts.contains("'testCase'"));
    assert!(ts.contains("'explicit'"));
    assert!(ts.contains("& RecipeChild"));
    assert!(!ts.contains("required_value"));
}

#[test]
fn emits_every_real_variant_and_referenced_type() {
    let ts = emit_ts();
    for source in SOURCES {
        for item in syn::parse_file(source).unwrap().items {
            if let Item::Enum(item) = item {
                if item.ident != "Op" && item.ident != "Output" {
                    continue;
                }
                let options = serde(&item.attrs).unwrap();
                for variant in item.variants {
                    let naming = Serde {
                        rename: serde(&variant.attrs).unwrap().rename,
                        rename_all: options.rename_all.clone(),
                        ..Serde::default()
                    };
                    let value = wire_name(&variant.ident.to_string(), &naming);
                    assert!(ts.contains(&format!("'{value}'")), "missing {value}");
                }
            }
        }
    }
    assert!(ts.contains("export type RecipeLayer"));
    assert!(ts.contains("export type RecipeRawSpec"));
    assert!(ts.contains("export type RecipeAuxRef"));
    assert!(ts.contains("export type RecipeConvolveOp"));
    assert!(!ts.contains("unknown"));
}

#[test]
#[should_panic(expected = "unsupported recipe container")]
fn rejects_unsupported_wire_containers_instead_of_emitting_unknown() {
    let ty: Type = syn::parse_str("HashMap<String>").unwrap();
    ts_type(&ty, &mut BTreeSet::new());
}

#[test]
fn rejects_unhandled_serde_attributes() {
    let item: syn::ItemStruct =
        syn::parse_str("#[serde(flatten)] struct Wire { value: u8 }").unwrap();
    assert!(serde(&item.attrs).is_err());
}
