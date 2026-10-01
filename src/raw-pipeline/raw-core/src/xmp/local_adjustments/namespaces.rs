use crate::error::{Error, Result};
use quick_xml::events::BytesStart;
use std::collections::BTreeMap;

/// Namespace scopes are needed only while importing XMP, outside the render loop.
#[derive(Default)]
pub(super) struct Namespaces {
    scopes: Vec<BTreeMap<String, String>>,
}

impl Namespaces {
    fn scope(&self, element: &BytesStart<'_>) -> Result<BTreeMap<String, String>> {
        let mut scope = self.scopes.last().cloned().unwrap_or_default();
        for attribute in element.attributes() {
            let attribute = attribute.map_err(|error| Error::Xmp(error.to_string()))?;
            let name = std::str::from_utf8(attribute.key.as_ref())
                .map_err(|error| Error::Xmp(error.to_string()))?;
            let prefix = if name == "xmlns" {
                Some("")
            } else {
                name.strip_prefix("xmlns:")
            };
            if let Some(prefix) = prefix {
                let uri = attribute
                    .unescape_value()
                    .map_err(|error| Error::Xmp(error.to_string()))?;
                scope.insert(prefix.to_owned(), uri.into_owned());
            }
        }
        Ok(scope)
    }

    fn name(name: &str, scope: &BTreeMap<String, String>, attribute: bool) -> String {
        let (prefix, local) = name.split_once(':').unwrap_or(("", name));
        if prefix.is_empty() && attribute {
            return name.to_owned();
        }
        let Some(uri) = scope.get(prefix) else {
            // Existing fragment fixtures omit the standard declarations.
            return name.to_owned();
        };
        let canonical = match uri.as_str() {
            "http://ns.adobe.com/camera-raw-settings/1.0/" => "crs",
            "http://ns.justmaple.app/photo/1.0/" | "http://ns.justmaple.app/1.0/" => "papp",
            "http://www.w3.org/1999/02/22-rdf-syntax-ns#" => "rdf",
            _ => return format!("unowned:{local}"),
        };
        format!("{canonical}:{local}")
    }

    fn normalized(
        element: &BytesStart<'_>,
        scope: &BTreeMap<String, String>,
    ) -> Result<(String, BytesStart<'static>)> {
        let binding = element.name();
        let raw_name =
            std::str::from_utf8(binding.as_ref()).map_err(|error| Error::Xmp(error.to_string()))?;
        let name = Self::name(raw_name, scope, false);
        let mut normalized = BytesStart::new(name.clone());
        for attribute in element.attributes() {
            let attribute = attribute.map_err(|error| Error::Xmp(error.to_string()))?;
            let raw = std::str::from_utf8(attribute.key.as_ref())
                .map_err(|error| Error::Xmp(error.to_string()))?;
            if raw == "xmlns" || raw.starts_with("xmlns:") {
                continue;
            }
            let canonical = Self::name(raw, scope, true);
            if canonical.starts_with("unowned:") {
                continue;
            }
            normalized.push_attribute((canonical.as_bytes(), attribute.value.as_ref()));
        }
        Ok((name, normalized.into_owned()))
    }

    pub(super) fn start(
        &mut self,
        element: &BytesStart<'_>,
    ) -> Result<(String, BytesStart<'static>)> {
        let scope = self.scope(element)?;
        let normalized = Self::normalized(element, &scope)?;
        self.scopes.push(scope);
        Ok(normalized)
    }

    pub(super) fn empty(&self, element: &BytesStart<'_>) -> Result<(String, BytesStart<'static>)> {
        Self::normalized(element, &self.scope(element)?)
    }

    pub(super) fn end(&mut self, name: &str) -> String {
        let result = self
            .scopes
            .last()
            .map_or_else(|| name.to_owned(), |scope| Self::name(name, scope, false));
        self.scopes.pop();
        result
    }
}
