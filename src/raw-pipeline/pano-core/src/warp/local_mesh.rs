//! Sparse local mesh warp scaffolding.
//!
//! This module intentionally stops short of a full local-warp solver. It
//! provides the production data model and deterministic mesh interpolation,
//! plus safe no-op and constant-displacement paths that downstream stitching
//! code can use while the sparse solver evolves.

use crate::error::PanoError;
use crate::warp::canvas::Canvas;
use crate::warp::project::{canvas_pixel_to_projection, ProjectionPoint};

const DEFAULT_MESH_COLS: u32 = 9;
const DEFAULT_MESH_ROWS: u32 = 9;
const MAX_MESH_VERTICES: usize = 65_536;

/// Options controlling the per-image local warp mesh.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalWarpOptions {
    pub mesh_cols: u32,
    pub mesh_rows: u32,
    /// Maximum absolute displacement component accepted for the temporary
    /// constant-field path. Use `0.0` to force a no-op output.
    pub max_displacement_px: f32,
}

impl Default for LocalWarpOptions {
    fn default() -> Self {
        Self {
            mesh_cols: DEFAULT_MESH_COLS,
            mesh_rows: DEFAULT_MESH_ROWS,
            max_displacement_px: 256.0,
        }
    }
}

impl LocalWarpOptions {
    pub fn validate(self) -> Result<(), PanoError> {
        if self.mesh_cols < 2 || self.mesh_rows < 2 {
            return Err(PanoError::Warp(
                "local mesh requires at least 2 columns and 2 rows".into(),
            ));
        }
        let vertices = mesh_vertex_count(self.mesh_cols, self.mesh_rows)?;
        if vertices > MAX_MESH_VERTICES {
            return Err(PanoError::Warp(format!(
                "local mesh has {vertices} vertices, max is {MAX_MESH_VERTICES}"
            )));
        }
        if !self.max_displacement_px.is_finite() || self.max_displacement_px < 0.0 {
            return Err(PanoError::Warp(
                "local mesh max displacement must be finite and non-negative".into(),
            ));
        }
        Ok(())
    }
}

/// A 2-D local warp displacement in canvas pixels.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LocalWarpDisplacement {
    pub dx: f32,
    pub dy: f32,
}

impl LocalWarpDisplacement {
    pub const ZERO: Self = Self { dx: 0.0, dy: 0.0 };

    pub fn new(dx: f32, dy: f32) -> Self {
        Self { dx, dy }
    }

    #[inline]
    pub fn is_finite(self) -> bool {
        self.dx.is_finite() && self.dy.is_finite()
    }

    #[inline]
    pub fn max_abs_component(self) -> f32 {
        self.dx.abs().max(self.dy.abs())
    }

    #[inline]
    pub fn clamped_components(self, max_abs: f32) -> Self {
        Self {
            dx: self.dx.clamp(-max_abs, max_abs),
            dy: self.dy.clamp(-max_abs, max_abs),
        }
    }
}

/// A per-image displacement mesh defined over a canvas.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalWarpField {
    canvas_width: u32,
    canvas_height: u32,
    mesh_cols: u32,
    mesh_rows: u32,
    displacements: Vec<LocalWarpDisplacement>,
}

impl LocalWarpField {
    pub fn try_new(
        canvas_width: u32,
        canvas_height: u32,
        mesh_cols: u32,
        mesh_rows: u32,
        displacements: Vec<LocalWarpDisplacement>,
    ) -> Result<Self, PanoError> {
        validate_canvas_size(canvas_width, canvas_height)?;
        let expected = mesh_vertex_count(mesh_cols, mesh_rows)?;
        if mesh_cols < 2 || mesh_rows < 2 {
            return Err(PanoError::Warp(
                "local mesh requires at least 2 columns and 2 rows".into(),
            ));
        }
        if expected > MAX_MESH_VERTICES {
            return Err(PanoError::Warp(format!(
                "local mesh has {expected} vertices, max is {MAX_MESH_VERTICES}"
            )));
        }
        if displacements.len() != expected {
            return Err(PanoError::Warp(format!(
                "local mesh displacement count mismatch: got {}, expected {expected}",
                displacements.len()
            )));
        }
        if displacements.iter().any(|d| !d.is_finite()) {
            return Err(PanoError::Warp(
                "local mesh contains non-finite displacement".into(),
            ));
        }

        Ok(Self {
            canvas_width,
            canvas_height,
            mesh_cols,
            mesh_rows,
            displacements,
        })
    }

    pub fn no_op(canvas: &Canvas, options: LocalWarpOptions) -> Result<Self, PanoError> {
        options.validate()?;
        Self::constant(canvas, options, LocalWarpDisplacement::ZERO)
    }

    pub fn constant(
        canvas: &Canvas,
        options: LocalWarpOptions,
        displacement: LocalWarpDisplacement,
    ) -> Result<Self, PanoError> {
        options.validate()?;
        if !displacement.is_finite() {
            return Err(PanoError::Warp(
                "local mesh constant displacement must be finite".into(),
            ));
        }
        let displacement = displacement.clamped_components(options.max_displacement_px);
        let count = mesh_vertex_count(options.mesh_cols, options.mesh_rows)?;
        Self::try_new(
            canvas.width,
            canvas.height,
            options.mesh_cols,
            options.mesh_rows,
            vec![displacement; count],
        )
    }

    #[inline]
    pub fn canvas_width(&self) -> u32 {
        self.canvas_width
    }

    #[inline]
    pub fn canvas_height(&self) -> u32 {
        self.canvas_height
    }

    #[inline]
    pub fn mesh_cols(&self) -> u32 {
        self.mesh_cols
    }

    #[inline]
    pub fn mesh_rows(&self) -> u32 {
        self.mesh_rows
    }

    #[inline]
    pub fn displacements(&self) -> &[LocalWarpDisplacement] {
        &self.displacements
    }

    pub fn vertex(&self, col: u32, row: u32) -> Option<LocalWarpDisplacement> {
        self.vertex_index(col, row)
            .map(|idx| self.displacements[idx])
    }

    pub fn set_vertex(
        &mut self,
        col: u32,
        row: u32,
        displacement: LocalWarpDisplacement,
    ) -> Result<(), PanoError> {
        if !displacement.is_finite() {
            return Err(PanoError::Warp(
                "local mesh vertex displacement must be finite".into(),
            ));
        }
        let idx = self
            .vertex_index(col, row)
            .ok_or_else(|| PanoError::Warp("local mesh vertex index out of bounds".into()))?;
        self.displacements[idx] = displacement;
        Ok(())
    }

    /// Canvas pixel coordinate of a mesh vertex.
    pub fn vertex_canvas_position(&self, col: u32, row: u32) -> Option<(f32, f32)> {
        if col >= self.mesh_cols || row >= self.mesh_rows {
            return None;
        }
        let x = vertex_axis_position(col, self.mesh_cols, self.canvas_width);
        let y = vertex_axis_position(row, self.mesh_rows, self.canvas_height);
        Some((x, y))
    }

    /// Bilinearly sample the local displacement at a canvas pixel coordinate.
    ///
    /// Returns `None` outside the inclusive canvas pixel bounds:
    /// `[0, width - 1] x [0, height - 1]`.
    pub fn sample(&self, x: f32, y: f32) -> Option<LocalWarpDisplacement> {
        if !x.is_finite()
            || !y.is_finite()
            || x < 0.0
            || y < 0.0
            || x > (self.canvas_width - 1) as f32
            || y > (self.canvas_height - 1) as f32
        {
            return None;
        }

        let gx = axis_grid_coordinate(x, self.canvas_width, self.mesh_cols);
        let gy = axis_grid_coordinate(y, self.canvas_height, self.mesh_rows);

        let x0 = (gx.floor() as u32).min(self.mesh_cols - 1);
        let y0 = (gy.floor() as u32).min(self.mesh_rows - 1);
        let x1 = (x0 + 1).min(self.mesh_cols - 1);
        let y1 = (y0 + 1).min(self.mesh_rows - 1);
        let fx = if x0 == x1 { 0.0 } else { gx - x0 as f32 };
        let fy = if y0 == y1 { 0.0 } else { gy - y0 as f32 };

        let d00 = self.vertex(x0, y0)?;
        let d10 = self.vertex(x1, y0)?;
        let d01 = self.vertex(x0, y1)?;
        let d11 = self.vertex(x1, y1)?;

        let lerp = |a: f32, b: f32, t: f32| a * (1.0 - t) + b * t;
        let top_dx = lerp(d00.dx, d10.dx, fx);
        let bot_dx = lerp(d01.dx, d11.dx, fx);
        let top_dy = lerp(d00.dy, d10.dy, fx);
        let bot_dy = lerp(d01.dy, d11.dy, fx);

        Some(LocalWarpDisplacement {
            dx: lerp(top_dx, bot_dx, fy),
            dy: lerp(top_dy, bot_dy, fy),
        })
    }

    pub fn warp_canvas_point(&self, x: f32, y: f32) -> Option<(f32, f32)> {
        let d = self.sample(x, y)?;
        Some((x + d.dx, y + d.dy))
    }

    #[inline]
    fn vertex_index(&self, col: u32, row: u32) -> Option<usize> {
        if col >= self.mesh_cols || row >= self.mesh_rows {
            return None;
        }
        Some((row as usize) * (self.mesh_cols as usize) + col as usize)
    }
}

/// A sparse local-warp observation attached to one image.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalWarpObservation {
    pub image_index: usize,
    pub canvas_x: f32,
    pub canvas_y: f32,
    pub projection_point: ProjectionPoint,
    pub displacement: LocalWarpDisplacement,
    pub weight: f32,
}

impl LocalWarpObservation {
    pub fn new(
        image_index: usize,
        canvas_x: f32,
        canvas_y: f32,
        projection_point: ProjectionPoint,
        displacement: LocalWarpDisplacement,
        weight: f32,
    ) -> Self {
        Self {
            image_index,
            canvas_x,
            canvas_y,
            projection_point,
            displacement,
            weight,
        }
    }

    pub fn from_canvas(
        canvas: &Canvas,
        image_index: usize,
        canvas_x: f32,
        canvas_y: f32,
        displacement: LocalWarpDisplacement,
        weight: f32,
    ) -> Option<Self> {
        let projection_point = canvas_pixel_to_projection(canvas, canvas_x, canvas_y)?;
        Some(Self::new(
            image_index,
            canvas_x,
            canvas_y,
            projection_point,
            displacement,
            weight,
        ))
    }

    fn is_usable_for(&self, canvas: &Canvas) -> bool {
        self.canvas_x.is_finite()
            && self.canvas_y.is_finite()
            && self.canvas_x >= 0.0
            && self.canvas_y >= 0.0
            && self.canvas_x <= (canvas.width - 1) as f32
            && self.canvas_y <= (canvas.height - 1) as f32
            && self.projection_point.projection == canvas.projection
            && self.projection_point.is_finite()
            && self.displacement.is_finite()
            && self.weight.is_finite()
            && self.weight > 0.0
    }
}

/// One image's local mesh field.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageLocalWarpField {
    pub image_index: usize,
    pub field: LocalWarpField,
}

/// Diagnostic counters for local mesh construction.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LocalWarpDiagnostics {
    pub image_count: usize,
    pub observation_count: usize,
    pub used_observation_count: usize,
    pub rejected_observation_count: usize,
    pub no_op_field_count: usize,
    pub constant_field_count: usize,
    pub mesh_cols: u32,
    pub mesh_rows: u32,
    pub max_abs_displacement_px: f32,
}

/// Result of building per-image local warp fields.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalWarpResult {
    pub fields: Vec<ImageLocalWarpField>,
    pub diagnostics: LocalWarpDiagnostics,
}

impl LocalWarpResult {
    pub fn field_for_image(&self, image_index: usize) -> Option<&LocalWarpField> {
        self.fields
            .iter()
            .find(|field| field.image_index == image_index)
            .map(|field| &field.field)
    }
}

/// Build no-op local warp fields for every image.
pub fn build_no_op_local_warp_fields(
    image_count: usize,
    canvas: &Canvas,
    options: LocalWarpOptions,
) -> Result<LocalWarpResult, PanoError> {
    build_local_warp_fields(image_count, canvas, &[], options)
}

/// Build per-image local warp fields from sparse observations.
///
/// Current production-safe behavior:
///
/// - no observations for an image -> no-op field
/// - usable observations for an image -> one clamped weighted-mean constant field
///
/// This gives callers a stable interpolation surface without pretending the
/// sparse mesh solver is implemented yet.
pub fn build_local_warp_fields(
    image_count: usize,
    canvas: &Canvas,
    observations: &[LocalWarpObservation],
    options: LocalWarpOptions,
) -> Result<LocalWarpResult, PanoError> {
    options.validate()?;
    validate_canvas_size(canvas.width, canvas.height)?;

    let mut accum = vec![ObservationAccumulator::default(); image_count];
    let mut diagnostics = LocalWarpDiagnostics {
        image_count,
        observation_count: observations.len(),
        mesh_cols: options.mesh_cols,
        mesh_rows: options.mesh_rows,
        ..LocalWarpDiagnostics::default()
    };

    for obs in observations {
        if obs.image_index >= image_count || !obs.is_usable_for(canvas) {
            diagnostics.rejected_observation_count += 1;
            continue;
        }
        accum[obs.image_index].add(*obs);
        diagnostics.used_observation_count += 1;
    }

    let mut fields = Vec::with_capacity(image_count);
    for (image_index, acc) in accum.iter().enumerate() {
        let field = if acc.count == 0 {
            diagnostics.no_op_field_count += 1;
            LocalWarpField::no_op(canvas, options)?
        } else {
            diagnostics.constant_field_count += 1;
            let displacement = acc
                .mean_displacement()
                .clamped_components(options.max_displacement_px);
            diagnostics.max_abs_displacement_px = diagnostics
                .max_abs_displacement_px
                .max(displacement.max_abs_component());
            LocalWarpField::constant(canvas, options, displacement)?
        };
        fields.push(ImageLocalWarpField { image_index, field });
    }

    Ok(LocalWarpResult {
        fields,
        diagnostics,
    })
}

#[derive(Debug, Clone, Copy, Default)]
struct ObservationAccumulator {
    dx_weighted_sum: f32,
    dy_weighted_sum: f32,
    weight_sum: f32,
    count: usize,
}

impl ObservationAccumulator {
    fn add(&mut self, obs: LocalWarpObservation) {
        self.dx_weighted_sum += obs.displacement.dx * obs.weight;
        self.dy_weighted_sum += obs.displacement.dy * obs.weight;
        self.weight_sum += obs.weight;
        self.count += 1;
    }

    fn mean_displacement(self) -> LocalWarpDisplacement {
        if self.weight_sum <= 0.0 {
            return LocalWarpDisplacement::ZERO;
        }
        LocalWarpDisplacement {
            dx: self.dx_weighted_sum / self.weight_sum,
            dy: self.dy_weighted_sum / self.weight_sum,
        }
    }
}

fn validate_canvas_size(width: u32, height: u32) -> Result<(), PanoError> {
    if width == 0 || height == 0 {
        return Err(PanoError::Warp(
            "local mesh canvas dimensions must be non-zero".into(),
        ));
    }
    Ok(())
}

fn mesh_vertex_count(cols: u32, rows: u32) -> Result<usize, PanoError> {
    let cols = cols as usize;
    let rows = rows as usize;
    cols.checked_mul(rows)
        .ok_or_else(|| PanoError::Warp("local mesh vertex count overflowed".into()))
}

#[inline]
fn vertex_axis_position(index: u32, vertex_count: u32, canvas_extent: u32) -> f32 {
    if canvas_extent <= 1 {
        return 0.0;
    }
    index as f32 * (canvas_extent - 1) as f32 / (vertex_count - 1) as f32
}

#[inline]
fn axis_grid_coordinate(pixel: f32, canvas_extent: u32, vertex_count: u32) -> f32 {
    if canvas_extent <= 1 {
        return 0.0;
    }
    pixel * (vertex_count - 1) as f32 / (canvas_extent - 1) as f32
}
