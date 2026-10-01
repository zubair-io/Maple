//! Read-only source lookup for removal gestures (#3934). Uses the renderer's
//! coefficient blend and polynomial, in its ActiveArea pixel-index convention.
use super::{blend_warp_toward_identity, warp_source};
use crate::pipeline::pano::opcodes::{ActiveAreaRect, WarpPlaneParams, WarpRectilinearOpcode};

pub(crate) struct WarpPointMap {
    area: ActiveAreaRect,
    center: [f64; 2],
    radius: f64,
    inverse_radius: f64,
    green: WarpPlaneParams,
}

impl WarpPointMap {
    pub(crate) fn new(
        warp: &WarpRectilinearOpcode,
        area: ActiveAreaRect,
        distortion: f32,
        ca: f32,
    ) -> Result<Self, String> {
        if area.width == 0 || area.height == 0 || warp.planes.is_empty() {
            return Err("removal geometry: empty optical mapping".into());
        }
        let w = area.width as f64;
        let h = area.height as f64;
        let cx = warp.center_x * w;
        let cy = warp.center_y * h;
        let radius = f64::hypot(cx.abs().max((w - cx).abs()), cy.abs().max((h - cy).abs()));
        let green = warp.planes[1.min(warp.planes.len() - 1)];
        let green = blend_warp_toward_identity(&green, &green, distortion as f64, ca as f64);
        if !radius.is_finite()
            || radius <= 0.0
            || green
                .kr
                .iter()
                .chain(green.kt.iter())
                .any(|v| !v.is_finite())
        {
            return Err("removal geometry: invalid optical mapping".into());
        }
        Ok(Self {
            area,
            center: [cx, cy],
            radius,
            inverse_radius: 1.0 / radius,
            green,
        })
    }

    /// Sticky-edge green-reference source for an output sensor pixel. Outside
    /// ActiveArea the renderer passes pixels through, so this lookup does too.
    pub(crate) fn source(&self, point: [f64; 2]) -> [f64; 2] {
        let [x, y] = [
            point[0] - self.area.left as f64,
            point[1] - self.area.top as f64,
        ];
        let (w, h) = (self.area.width as f64, self.area.height as f64);
        if x < 0.0 || y < 0.0 || x >= w || y >= h {
            return point;
        }
        let [cx, cy] = self.center;
        let (x, y) = warp_source(
            &self.green,
            x - cx,
            y - cy,
            cx,
            cy,
            self.inverse_radius,
            self.radius,
        );
        [
            x.clamp(0.0, w - 1.0) + self.area.left as f64,
            y.clamp(0.0, h - 1.0) + self.area.top as f64,
        ]
    }
}
