//! EXIF identity → bundled lens. Exact canonical matching only: no fuzzy
//! scoring and no "closest lens", the same stance the LCP resolver takes.
//! What is allowed: any of a lens's spellings (`model` plus its `lang`
//! variants), any of a camera's spellings (`model` plus `variant`s), and a
//! lens on the camera's mount or on a mount that mount lists as compatible
//! (adapted glass). A calibration made on a smaller sensor is refused for a
//! larger one, as `liblensfun` does (`camera_crop / lens_crop ≥ 0.96`).

use super::bundle::{Camera, Database, Lens, Mount};
use super::names::{canonical, canonical_camera};

/// Smallest `camera_crop / calibration_crop` a calibration may serve.
pub const MIN_CROP_RATIO: f64 = 0.96;

#[derive(Clone, Debug)]
pub struct Match<'a> {
    pub camera: &'a Camera,
    pub lens: &'a Lens,
    pub mount: &'a Mount,
    pub slug: String,
}

fn camera_named<'a>(db: &'a Database, make: &str, model: &str) -> Option<&'a Camera> {
    let wanted = canonical_camera(make, model);
    if wanted.is_empty() {
        return None;
    }
    db.cameras.iter().find(|camera| {
        std::iter::once(&camera.model)
            .chain(&camera.variants)
            .any(|name| canonical_camera(&camera.maker, name) == wanted)
    })
}

fn lens_named<'a>(lens: &'a Lens, wanted: &str) -> bool {
    std::iter::once(&lens.model)
        .chain(&lens.names)
        .any(|name| canonical(&lens.maker, name) == wanted)
}

/// Mount indices a body on `mount` can carry glass for: its own and the
/// `compat` list, resolved by name.
fn usable_mounts(db: &Database, mount: usize) -> Vec<usize> {
    let own = &db.mounts[mount];
    std::iter::once(mount)
        .chain(own.compat.iter().filter_map(|name| {
            db.mounts
                .iter()
                .position(|candidate| candidate.name == *name)
        }))
        .collect()
}

fn serves(lens: &Lens, camera: &Camera, mounts: &[usize]) -> Option<usize> {
    if !lens.rectilinear || camera.crop / lens.crop < MIN_CROP_RATIO {
        return None;
    }
    lens.mounts.iter().copied().find(|m| mounts.contains(m))
}

/// EXIF make, camera model and lens name → the bundled lens, or `None`
/// when either identity has no exact match, the lens is not rectilinear,
/// or the calibration sensor is larger than the camera's.
pub fn find<'a>(
    db: &'a Database,
    make: &str,
    camera_model: &str,
    lens_name: &str,
) -> Option<Match<'a>> {
    let camera = camera_named(db, make, camera_model)?;
    let wanted = canonical(make, lens_name);
    if wanted.is_empty() {
        return None;
    }
    let mounts = usable_mounts(db, camera.mount);
    db.lenses.iter().find_map(|lens| {
        let mount = serves(lens, camera, &mounts)?;
        lens_named(lens, &wanted).then(|| Match {
            camera,
            lens,
            mount: &db.mounts[mount],
            slug: slug(lens, &db.mounts[mount]),
        })
    })
}

/// Every rectilinear lens a body can carry with a usable calibration,
/// sorted by maker then model — the dropdown's contents.
pub fn compatible<'a>(db: &'a Database, camera: &Camera) -> Vec<&'a Lens> {
    let mounts = usable_mounts(db, camera.mount);
    let mut list = db
        .lenses
        .iter()
        .filter(|lens| serves(lens, camera, &mounts).is_some())
        .collect::<Vec<_>>();
    list.sort_by(|a, b| (&a.maker, &a.model).cmp(&(&b.maker, &b.model)));
    list
}

/// The `lensfun1:` payload: `<maker>/<lens>@<mount>`, every part canonical.
pub fn slug(lens: &Lens, mount: &Mount) -> String {
    format!(
        "{}/{}@{}",
        canonical("", &lens.maker),
        canonical(&lens.maker, &lens.model),
        canonical("", &mount.name)
    )
}

pub fn by_slug<'a>(db: &'a Database, slug_text: &str) -> Option<(&'a Lens, &'a Mount)> {
    let (_, mount_part) = slug_text.rsplit_once('@')?;
    let mount = db
        .mounts
        .iter()
        .find(|m| canonical("", &m.name) == mount_part)?;
    let mount_index = db.mounts.iter().position(|m| std::ptr::eq(m, mount))?;
    db.lenses
        .iter()
        .find(|lens| lens.mounts.contains(&mount_index) && slug(lens, mount) == slug_text)
        .map(|lens| (lens, mount))
}
