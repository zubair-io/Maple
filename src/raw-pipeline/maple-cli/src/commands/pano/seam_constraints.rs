use std::path::Path;

use maple_pano::seam::SeamConstraintsRequest;

pub(super) fn load(path: Option<&Path>) -> Result<Option<SeamConstraintsRequest>, String> {
    path.map(|p| {
        let json = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
        SeamConstraintsRequest::parse(&json, usize::MAX)
            .map_err(|e| format!("{}: {e}", p.display()))
    })
    .transpose()
}
