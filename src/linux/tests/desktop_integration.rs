use maple_linux::library::FILE_FORMATS;
use std::collections::BTreeSet;
use std::path::PathBuf;

fn packaging(name: &str) -> String {
    std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("packaging")
            .join(name),
    )
    .unwrap()
}

#[test]
fn desktop_entry_associates_exactly_the_formats_the_library_opens() {
    let mut seen = std::collections::HashSet::new();
    let expected: Vec<&str> = FILE_FORMATS
        .iter()
        .map(|format| format.mime_type)
        .filter(|mime| seen.insert(*mime))
        .collect();
    let entry = packaging("app.justmaple.aperture.desktop");
    let declared = entry
        .lines()
        .find_map(|line| line.strip_prefix("MimeType="))
        .expect("desktop entry declares MimeType");
    assert_eq!(declared, format!("{};", expected.join(";")));
    assert!(entry.lines().any(|line| line == "Exec=maple-linux %f"));
}

#[test]
fn maple_mime_package_declares_exactly_the_types_shared_mime_info_lacks() {
    let source = packaging("app.justmaple.aperture.xml");
    let document = roxmltree::Document::parse(&source).unwrap();
    let declared: BTreeSet<(String, String, String)> = document
        .descendants()
        .filter(|node| node.has_tag_name("mime-type"))
        .map(|node| {
            let child = |name: &str| {
                node.children()
                    .find(|child| child.has_tag_name(name))
                    .unwrap_or_else(|| panic!("{name} missing"))
            };
            assert_eq!(
                child("sub-class-of").attribute("type"),
                Some("image/x-dcraw")
            );
            (
                node.attribute("type").unwrap().to_string(),
                child("glob").attribute("pattern").unwrap().to_string(),
                child("comment").text().unwrap().to_string(),
            )
        })
        .collect();
    let expected: BTreeSet<(String, String, String)> = FILE_FORMATS
        .iter()
        .filter_map(|format| {
            Some((
                format.mime_type.to_string(),
                format!("*.{}", format.extension),
                format.declared_comment?.to_string(),
            ))
        })
        .collect();
    assert_eq!(declared, expected);
}

/// The installed database is the ground truth for types Maple does not
/// declare itself; skip-passes where shared-mime-info is absent (macOS).
#[test]
fn system_mime_database_resolves_every_type_maple_relies_on() {
    let Ok(globs) = std::fs::read_to_string("/usr/share/mime/globs2") else {
        return;
    };
    let entries: BTreeSet<(&str, &str)> = globs
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(':');
            let _weight = fields.next()?;
            Some((fields.next()?, fields.next()?))
        })
        .collect();
    let missing: Vec<String> = FILE_FORMATS
        .iter()
        .filter(|format| format.declared_comment.is_none())
        .map(|format| (format.mime_type, format!("*.{}", format.extension)))
        .filter(|(mime, glob)| !entries.contains(&(*mime, glob.as_str())))
        .map(|(mime, glob)| format!("{mime} {glob}"))
        .collect();
    assert!(missing.is_empty(), "not in shared-mime-info: {missing:?}");
}
