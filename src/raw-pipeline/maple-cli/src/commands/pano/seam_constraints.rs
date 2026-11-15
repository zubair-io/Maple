use std::path::Path;

use maple_pano::seam::{SeamConstraintError, SeamConstraintsRequest};

pub(super) fn load(
    path: Option<&Path>,
) -> Result<Option<SeamConstraintsRequest>, SeamConstraintError> {
    path.map(|p| {
        let json = std::fs::read_to_string(p)
            .map_err(|e| SeamConstraintError::InvalidRequest(format!("{}: {e}", p.display())))?;
        SeamConstraintsRequest::parse(&json, usize::MAX)
    })
    .transpose()
}
