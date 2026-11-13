//! Controlled photographic SDR comparison for #3941. This does not choose a
//! shipping recipe: AgX gamut compression is many-to-one, and the identity
//! bake explicitly measures the inverse's lost scene information.
use raw_core::color::matrices::M_SRGB_TO_REC2020;
use raw_core::image::{ColorSpace, Image};
use raw_core::pipeline::RemovalModelEncoding;
use raw_core::view::{agx, agx_inverse, encode};
use serde::{Deserialize, Serialize};

#[path = "photographic_encoding.rs"]
mod photographic_encoding;
use photographic_encoding::PhotographicContrast;

type ProbeResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProbeEncoding {
    SignedLog(RemovalModelEncoding),
    FixedSdr(FixedSdr),
    PhotographicContrast(PhotographicContrast),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FixedSdr {
    method: String,
    agx_version: u32,
}

impl ProbeEncoding {
    pub fn fit(
        scene: &[[f32; 3]],
        fixed_sdr: bool,
        photographic_contrast: bool,
    ) -> ProbeResult<Self> {
        if fixed_sdr && photographic_contrast {
            return Err("choose one research encoding".into());
        }
        if photographic_contrast {
            Ok(Self::PhotographicContrast(PhotographicContrast::fit(
                scene,
            )?))
        } else if fixed_sdr {
            Ok(Self::FixedSdr(FixedSdr {
                method: "fixed-agx-srgb".into(),
                agx_version: agx::AGX_VERSION,
            }))
        } else {
            Ok(Self::SignedLog(RemovalModelEncoding::fit(scene)?))
        }
    }

    fn validate(&self) -> ProbeResult<()> {
        if let Self::PhotographicContrast(recipe) = self {
            recipe.validate()?;
        }
        if let Self::FixedSdr(recipe) = self {
            if recipe.method != "fixed-agx-srgb" || recipe.agx_version != agx::AGX_VERSION {
                return Err("unsupported fixed photographic SDR recipe".into());
            }
        }
        Ok(())
    }

    pub fn encode(&self, scene: &[[f32; 3]]) -> ProbeResult<Vec<[f32; 3]>> {
        self.validate()?;
        if scene.iter().flatten().any(|v| !v.is_finite()) {
            return Err("nonfinite scene sample".into());
        }
        match self {
            Self::SignedLog(recipe) => Ok(recipe.encode(scene)?),
            Self::PhotographicContrast(recipe) => recipe.encode(scene),
            Self::FixedSdr(_) => {
                let mut image = Image {
                    width: scene.len().try_into()?,
                    height: 1,
                    pixels: scene.to_vec(),
                    space: ColorSpace::SceneLinearRec2020,
                    whites_anchor_ev: None,
                    nr_sampling_scale: 1.0,
                };
                agx::apply_with_resolved_whites(&mut image, 0.0, 0.0);
                encode::rec2020_to_srgb(&mut image);
                Ok(image
                    .pixels
                    .into_iter()
                    .map(|p| p.map(encode::srgb_gamma))
                    .collect())
            }
        }
    }

    pub fn decode(&self, model: &[[f32; 3]]) -> ProbeResult<Vec<[f32; 3]>> {
        self.validate()?;
        if model
            .iter()
            .flatten()
            .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
        {
            return Err("invalid photographic model sample".into());
        }
        match self {
            Self::SignedLog(recipe) => Ok(recipe.decode(model)?),
            Self::PhotographicContrast(recipe) => recipe.decode(model),
            Self::FixedSdr(_) => Ok(model
                .iter()
                .map(|p| {
                    let display = M_SRGB_TO_REC2020.mul_vec(p.map(agx_inverse::srgb_gamma_inv));
                    agx_inverse::inverse_agx_pixel(display, 1.0, 0.0)
                })
                .collect()),
        }
    }
}
