using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    public static unsafe partial class RenderEngine
    {
        /// <summary>The wb_frame block spans 82 floats in both the buffer
        /// export and the params struct, in identical field order
        /// (9+1+9+1+1+1+9+9+3+1+9+1+9+1+9+9).</summary>
        public const int WbFrameFloatCount = 82;

        private static float[] CopyWbFrame(MapleSceneLinearBufferF32* b)
        {
            var f = new float[WbFrameFloatCount];
            var i = 0;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_m_cold[k];
            f[i++] = b->wb_frame_cct_cold;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_m_warm[k];
            f[i++] = b->wb_frame_cct_warm;
            f[i++] = b->wb_frame_scene_cct;
            f[i++] = b->wb_frame_as_shot_tint;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_cm[k];
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_forward_matrix[k];
            for (var k = 0; k < 3; k++) f[i++] = b->wb_frame_render_scene_white_xyz[k];
            f[i++] = b->wb_frame_render_wb_already_baked;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_cm_cold[k];
            f[i++] = b->wb_frame_render_cct_cold;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_cm_warm[k];
            f[i++] = b->wb_frame_render_cct_warm;
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_fm_cold[k];
            for (var k = 0; k < 9; k++) f[i++] = b->wb_frame_render_fm_warm[k];
            return f;
        }

        /// <summary>The decode's WB exports onto the CPU chain params: the
        /// wb_frame block, and the HueSatMap wire with its per-photo scalars
        /// (#5099; the wire is process-lifetime native memory, no pinning).</summary>
        private static void ApplyWbExports(ref MapleAdjustmentParams p, DecodedImage image)
        {
            p.wb_hsm_ptr = (float*)image.WbHueSatMap;
            p.wb_hsm_len = image.WbHueSatMapLength;
            p.wb_hsm_as_shot_cct = image.WbHueSatMapAsShotCct;
            p.wb_hsm_exposure_gain = image.AeGain;
            var f = image.WbFrame;
            var i = 0;
            fixed (MapleAdjustmentParams* pp = &p)
            {
                for (var k = 0; k < 9; k++) pp->wb_frame_m_cold[k] = f[i++];
                pp->wb_frame_cct_cold = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_m_warm[k] = f[i++];
                pp->wb_frame_cct_warm = f[i++];
                pp->wb_frame_scene_cct = f[i++];
                pp->wb_frame_as_shot_tint = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_cm[k] = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_forward_matrix[k] = f[i++];
                for (var k = 0; k < 3; k++) pp->wb_frame_render_scene_white_xyz[k] = f[i++];
                pp->wb_frame_render_wb_already_baked = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_cm_cold[k] = f[i++];
                pp->wb_frame_render_cct_cold = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_cm_warm[k] = f[i++];
                pp->wb_frame_render_cct_warm = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_fm_cold[k] = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_fm_warm[k] = f[i++];
            }
        }
    }
}
