//! Keep each cache tile in one compute pass. Wgpu tracks dispatch hazards,
//! including the GPU-written indirect count, within the pass.
use super::*;
use crate::frame_pool::PooledDispatch;

impl Workspace {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn encode_batched(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Buffer,
        guide: &wgpu::Buffer,
        groups: &wgpu::Buffer,
        selected: &wgpu::Buffer,
        accum: &wgpu::Buffer,
        p: &Params,
    ) {
        let pipelines = ctx.bm3d_pipelines();
        let prepare =
            |pipeline: &wgpu::ComputePipeline, params: &Params, buffers: &[&wgpu::Buffer]| {
                spatial::prepare_simple_dispatch(
                    ctx,
                    pipeline,
                    bytemuck::bytes_of(params),
                    buffers,
                    "bm3d-tile",
                )
            };
        let scan = prepare(
            &pipelines.scan_selected,
            p,
            &[selected, &self.flags, &self.blocks],
        );
        let sum = prepare(
            &pipelines.sum_blocks,
            p,
            &[&self.blocks, &self.indirect, &self.worklist],
        );
        let compact = prepare(
            &pipelines.compact_selected,
            p,
            &[&self.flags, &self.blocks, &self.worklist],
        );
        let cache = if p.control[1] == 0 {
            &pipelines.cache_hard
        } else {
            &pipelines.cache_spectra
        };
        let channels: [(PooledDispatch, PooledDispatch); 3] = std::array::from_fn(|channel| {
            let params = Params {
                control: [channel as u32, p.control[1], 0, 0],
                ..*p
            };
            let spectra = if p.control[1] == 0 {
                prepare(cache, &params, &[source, &self.worklist, &self.spectra])
            } else {
                prepare(
                    cache,
                    &params,
                    &[source, guide, &self.worklist, &self.spectra],
                )
            };
            let filter = prepare(
                &pipelines.filter,
                &params,
                &[&self.spectra, groups, &self.estimates],
            );
            (spectra, filter)
        });
        let gather = prepare(
            &pipelines.gather,
            p,
            &[source, groups, &self.estimates, accum],
        );
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("bm3d-tile"),
            timestamp_writes: None,
        });
        let mut dispatch =
            |pipeline: &wgpu::ComputePipeline, resources: &PooledDispatch, count: u32| {
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, resources.bind_group.as_ref(), &[]);
                let groups = count.div_ceil(64);
                let x = groups.min(65535);
                pass.dispatch_workgroups(x, if x == 0 { 0 } else { groups.div_ceil(x) }, 1);
            };
        let pixels = p.cache[2] * p.cache[3];
        dispatch(&pipelines.scan_selected, &scan, pixels.div_ceil(256) * 64);
        dispatch(&pipelines.sum_blocks, &sum, 64);
        dispatch(&pipelines.compact_selected, &compact, pixels);
        for (spectra, filter) in &channels {
            pass.set_pipeline(cache);
            pass.set_bind_group(0, spectra.bind_group.as_ref(), &[]);
            pass.dispatch_workgroups_indirect(&self.indirect, 0);
            pass.set_pipeline(&pipelines.filter);
            pass.set_bind_group(0, filter.bind_group.as_ref(), &[]);
            let groups = p.batch[2] * p.batch[3];
            let x = groups.min(65535);
            pass.dispatch_workgroups(x, groups.div_ceil(x), 1);
        }
        pass.set_pipeline(&pipelines.gather);
        pass.set_bind_group(0, gather.bind_group.as_ref(), &[]);
        let groups = ((p.cache[2] + 7) * (p.cache[3] + 7)).div_ceil(64);
        let x = groups.min(65535);
        pass.dispatch_workgroups(x, groups.div_ceil(x), 1);
    }
}
