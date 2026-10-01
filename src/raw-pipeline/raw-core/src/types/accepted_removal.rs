//! Accepted-edit identities and versioned plate semantics (#3936 / #3955). Native un-oriented DefaultCrop
//! coordinates and durable content references, independent of model runtime.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ContentDigest(String);

impl<'de> Deserialize<'de> for ContentDigest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

impl ContentDigest {
    pub fn for_bytes(bytes: &[u8]) -> Self {
        Self(format!("blake3:{}", blake3::hash(bytes).to_hex()))
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        let digest = Self(value.into());
        digest.validate()?;
        Ok(digest)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn hex(&self) -> &str {
        &self.0[7..]
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.0.starts_with("blake3:")
            || self.0.len() != 71
            || !self.0.as_bytes()[7..]
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            return Err("removal identity must be a lowercase BLAKE3 digest".into());
        }
        Ok(())
    }

    pub fn verify(&self, bytes: &[u8]) -> Result<(), String> {
        self.validate()?;
        if self != &Self::for_bytes(bytes) {
            return Err("removal asset checksum mismatch".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeWindow {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl NativeWindow {
    pub fn validate(&self, width: u32, height: u32) -> Result<(), String> {
        crate::types::removal_mask::validate_mask_layout(
            width,
            height,
            self.x,
            self.y,
            self.width,
            self.height,
        )?;
        Ok(())
    }

    pub fn region(&self, width: u32, height: u32) -> [f32; 4] {
        [
            self.x as f32 / width as f32,
            self.y as f32 / height as f32,
            self.width as f32 / width as f32,
            self.height as f32 / height as f32,
        ]
    }

    pub fn intersects(&self, other: &Self) -> bool {
        u64::from(self.x) < u64::from(other.x) + u64::from(other.width)
            && u64::from(other.x) < u64::from(self.x) + u64::from(self.width)
            && u64::from(self.y) < u64::from(other.y) + u64::from(other.height)
            && u64::from(other.y) < u64::from(self.y) + u64::from(self.height)
    }

    pub fn contains(&self, other: &Self) -> bool {
        self.x <= other.x
            && self.y <= other.y
            && u64::from(self.x) + u64::from(self.width)
                >= u64::from(other.x) + u64::from(other.width)
            && u64::from(self.y) + u64::from(self.height)
                >= u64::from(other.y) + u64::from(other.height)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceAnchor {
    /// Digest of immutable original bytes, separate from the file's location.
    pub original: ContentDigest,
    /// Decode, calibration and fixed WB recipe identity; creative grade excluded.
    pub decode: ContentDigest,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemovalDependency {
    /// Digest of the complete earlier removal record at generation time.
    pub record: ContentDigest,
    pub patch: ContentDigest,
}

/// The composition seam is part of the saved contract. A pre-WB calibration
/// patch cannot be interpreted as an older post-DCP scene patch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemovalPlate {
    #[default]
    PostDcpV1,
    LinearCalibrationV1,
}

impl RemovalPlate {
    fn is_legacy(&self) -> bool {
        *self == Self::PostDcpV1
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedRemoval {
    /// Omitted for schema 3 to preserve its wire bytes. Schema 4 requires the
    /// explicit linear-calibration-v1 plate; older readers reject that schema.
    #[serde(default, skip_serializing_if = "RemovalPlate::is_legacy")]
    pub plate: RemovalPlate,
    pub source: SourceAnchor,
    pub mask: ContentDigest,
    pub patch_window: NativeWindow,
    pub context_window: NativeWindow,
    pub model: ContentDigest,
    pub recipe: ContentDigest,
    /// Ordered intersecting preceding edits; a changed list needs review and
    /// retains accepted pixels. It never triggers automatic regeneration.
    pub dependencies: Vec<RemovalDependency>,
}

impl AcceptedRemoval {
    pub fn validate(&self) -> Result<(), String> {
        for digest in [
            &self.source.original,
            &self.source.decode,
            &self.mask,
            &self.model,
            &self.recipe,
        ] {
            digest.validate()?;
        }
        self.patch_window
            .validate(self.source.width, self.source.height)?;
        self.context_window
            .validate(self.source.width, self.source.height)?;
        if !self.context_window.contains(&self.patch_window) {
            return Err("removal context must contain its patch".into());
        }
        for (i, dep) in self.dependencies.iter().enumerate() {
            dep.record.validate()?;
            dep.patch.validate()?;
            if self.dependencies[..i]
                .iter()
                .any(|prior| prior.record == dep.record)
            {
                return Err("removal has duplicate context dependencies".into());
            }
        }
        Ok(())
    }
}
