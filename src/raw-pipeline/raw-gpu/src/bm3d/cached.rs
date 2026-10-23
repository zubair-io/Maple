//! Bounded strips of reusable patch spectra. Every selected patch is transformed
//! once per channel, then shared by every reference group that selected it.
use super::*;
use std::sync::Arc;

#[path = "cached_batch.rs"]
mod batch;

const SPECTRUM_FLOATS: u32 = (BLOCK * BLOCK + 1) as u32;
const ESTIMATE_FLOATS: u32 = (GROUP_MAX * BLOCK * BLOCK + 1) as u32;

pub(super) struct Workspace {
    flags: Arc<wgpu::Buffer>,
    spectra: Arc<wgpu::Buffer>,
    estimates: Arc<wgpu::Buffer>,
    blocks: Arc<wgpu::Buffer>,
    worklist: Arc<wgpu::Buffer>,
    indirect: Arc<wgpu::Buffer>,
    columns: u32,
    rows: u32,
    pixels: u32,
    groups: u32,
}

impl Workspace {
    pub(super) fn new(ctx: &GpuContext, width: u32, height: u32, nx: u32, ny: u32) -> Self {
        let block = BLOCK as u32;
        let stride = STRIDE as u32;
        let halo = 2 * SEARCH_HALF as u32 + 1;
        let patch_width = width - block + 1;
        let patch_height = height - block + 1;
        let limit = ctx
            .device
            .limits()
            .max_storage_buffer_binding_size
            .min(128 * 1024 * 1024);
        #[cfg(test)]
        let limit = TEST_CACHE_LIMIT.with(|override_limit| limit.min(override_limit.get()));
        let bytes_per_patch = SPECTRUM_FLOATS * 2 * 4;
        let maximum_width = (limit / (bytes_per_patch * halo)).max(1);
        let columns = if patch_width <= maximum_width {
            nx
        } else {
            ((maximum_width.saturating_sub(halo)) / stride + 1).min(nx)
        };
        let cache_width = if columns == nx {
            patch_width
        } else {
            ((columns - 1) * stride + halo).min(patch_width)
        };
        let maximum_height = limit / (cache_width * bytes_per_patch);
        let candidate_rows = if patch_height <= maximum_height {
            ny
        } else {
            ((maximum_height.saturating_sub(halo)) / stride + 1).min(ny)
        };
        let maximum_groups = limit / (ESTIMATE_FLOATS * 3 * 4);
        let rows = candidate_rows.min((maximum_groups / columns).max(1));
        let cache_height = if rows == ny {
            patch_height
        } else {
            ((rows - 1) * stride + halo).min(patch_height)
        };
        let pixels = cache_width * cache_height;
        let groups = columns * rows;
        Self {
            flags: spatial::alloc_plane(ctx, pixels, 1, "bm3d-selected-patches"),
            spectra: spatial::alloc_plane(
                ctx,
                pixels * SPECTRUM_FLOATS * 2,
                1,
                "bm3d-patch-spectra",
            ),
            estimates: spatial::alloc_plane(
                ctx,
                groups * ESTIMATE_FLOATS * 3,
                1,
                "bm3d-filtered-patches",
            ),
            blocks: spatial::alloc_plane(ctx, pixels.div_ceil(256), 1, "bm3d-prefix-blocks"),
            worklist: spatial::alloc_plane(ctx, pixels + 1, 1, "bm3d-patch-worklist"),
            indirect: crate::frame_pool::pool_scratch(ctx, 16, |device| {
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("bm3d-indirect-patches"),
                    size: 16,
                    usage: wgpu::BufferUsages::STORAGE
                        | wgpu::BufferUsages::INDIRECT
                        | wgpu::BufferUsages::COPY_SRC
                        | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            }),
            columns,
            rows,
            pixels,
            groups,
        }
    }

    #[cfg(test)]
    pub(super) fn is_tiled_for_test(&self, nx: u32, ny: u32) -> bool {
        self.columns < nx && self.rows < ny
    }

    fn spectra_dispatch(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        p: &Params,
        buffers: &[&wgpu::Buffer],
    ) {
        let pipeline = if p.control[1] == 0 {
            &ctx.bm3d_pipelines().cache_hard
        } else {
            &ctx.bm3d_pipelines().cache_spectra
        };
        #[cfg(test)]
        if super::gpu_profile::dispatch_indirect(
            ctx,
            encoder,
            pipeline,
            bytemuck::bytes_of(p),
            buffers,
            &self.indirect,
            "spectra",
        ) {
            return;
        }
        let pooled = spatial::prepare_simple_dispatch(
            ctx,
            pipeline,
            bytemuck::bytes_of(p),
            buffers,
            "bm3d-spectra",
        );
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("bm3d-spectra"),
            timestamp_writes: None,
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, pooled.bind_group.as_ref(), &[]);
        pass.dispatch_workgroups_indirect(&self.indirect, 0);
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Buffer,
        guide: &wgpu::Buffer,
        groups: &wgpu::Buffer,
        selected: &wgpu::Buffer,
        accum: &wgpu::Buffer,
        params: &Params,
        wiener: u32,
    ) {
        let pipelines = ctx.bm3d_pipelines();
        let [width, height, nx, ny] = params.dims;
        let dispatch = |encoder: &mut wgpu::CommandEncoder,
                        pipeline: &wgpu::ComputePipeline,
                        p: &Params,
                        buffers: &[&wgpu::Buffer],
                        count: u32,
                        label: &'static str| {
            #[cfg(test)]
            if super::gpu_profile::dispatch(
                ctx,
                encoder,
                pipeline,
                bytemuck::bytes_of(p),
                buffers,
                count,
                label,
            ) {
                return;
            }
            spatial::encode_simple(
                ctx,
                encoder,
                pipeline,
                bytemuck::bytes_of(p),
                buffers,
                count,
                label,
            );
        };
        for row in (0..ny).step_by(self.rows as usize) {
            for col in (0..nx).step_by(self.columns as usize) {
                let columns = self.columns.min(nx - col);
                let rows = self.rows.min(ny - row);
                let x0 = (col * STRIDE as u32)
                    .min(width - BLOCK as u32)
                    .saturating_sub(SEARCH_HALF as u32);
                let y0 = (row * STRIDE as u32)
                    .min(height - BLOCK as u32)
                    .saturating_sub(SEARCH_HALF as u32);
                let x1 = (((col + columns - 1) * STRIDE as u32).min(width - BLOCK as u32)
                    + SEARCH_HALF as u32)
                    .min(width - BLOCK as u32);
                let y1 = (((row + rows - 1) * STRIDE as u32).min(height - BLOCK as u32)
                    + SEARCH_HALF as u32)
                    .min(height - BLOCK as u32);
                let p = Params {
                    batch: [col, row, columns, rows],
                    cache: [x0, y0, x1 - x0 + 1, y1 - y0 + 1],
                    stream: [
                        self.pixels,
                        self.groups,
                        256,
                        if wiener == 0 { 16 } else { 8 },
                    ],
                    control: [0, wiener, 0, 0],
                    ..*params
                };
                #[cfg(test)]
                let separate = super::gpu_profile::active();
                #[cfg(not(test))]
                let separate = false;
                if !separate {
                    self.encode_batched(ctx, encoder, source, guide, groups, selected, accum, &p);
                    continue;
                }
                let pixels = p.cache[2] * p.cache[3];
                dispatch(
                    encoder,
                    &pipelines.scan_selected,
                    &p,
                    &[selected, &self.flags, &self.blocks],
                    pixels.div_ceil(256) * 64,
                    "scan",
                );
                dispatch(
                    encoder,
                    &pipelines.sum_blocks,
                    &p,
                    &[&self.blocks, &self.indirect, &self.worklist],
                    64,
                    "sum",
                );
                dispatch(
                    encoder,
                    &pipelines.compact_selected,
                    &p,
                    &[&self.flags, &self.blocks, &self.worklist],
                    pixels,
                    "compact",
                );
                for channel in 0..3 {
                    let p = Params {
                        control: [channel, wiener, 0, 0],
                        ..p
                    };
                    if wiener == 0 {
                        self.spectra_dispatch(
                            ctx,
                            encoder,
                            &p,
                            &[source, &self.worklist, &self.spectra],
                        );
                    } else {
                        self.spectra_dispatch(
                            ctx,
                            encoder,
                            &p,
                            &[source, guide, &self.worklist, &self.spectra],
                        );
                    }
                    dispatch(
                        encoder,
                        &pipelines.filter,
                        &p,
                        &[&self.spectra, groups, &self.estimates],
                        columns * rows * 64,
                        "filter",
                    );
                }
                dispatch(
                    encoder,
                    &pipelines.gather,
                    &p,
                    &[source, groups, &self.estimates, accum],
                    (p.cache[2] + 7) * (p.cache[3] + 7),
                    "gather",
                );
            }
        }
    }
}

#[cfg(test)]
thread_local! {
    pub(super) static TEST_CACHE_LIMIT: std::cell::Cell<u32> = const { std::cell::Cell::new(u32::MAX) };
}
