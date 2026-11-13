//! One saved-export wire contract for C and WASM (#3955).
use super::{ExportFormat, ExportOptions};
use crate::view::encode::TargetPrimaries;

pub fn parse_removal_export_options(json: &str) -> Result<ExportOptions, String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        format: String,
        quality: u8,
        color_space: String,
        max_long_edge: u32,
    }
    let request: Request = serde_json::from_str(json).map_err(|e| e.to_string())?;
    Ok(ExportOptions {
        format: ExportFormat::from_str(&request.format).ok_or("unsupported export format")?,
        quality: request.quality,
        max_long_edge: (request.max_long_edge > 0).then_some(request.max_long_edge),
        target: match request.color_space.as_str() {
            "srgb" => TargetPrimaries::Srgb,
            "display-p3" => TargetPrimaries::P3,
            _ => return Err("unsupported export colour space".into()),
        },
    })
}
