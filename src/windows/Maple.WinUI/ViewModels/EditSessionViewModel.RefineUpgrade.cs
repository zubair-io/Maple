using System;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        /// <summary>
        /// After the fast Preview decode for <paramref name="photo"/> has
        /// already landed and is on screen, escalate to a full AMaZE decode
        /// in the background when the session's decode target genuinely
        /// needs more detail than Preview's own half-native-resolution cap
        /// can deliver (#3417 review — mirrors Apple's
        /// <c>ImageEditPipeline.refineDecodeQuality</c> escalation, but as a
        /// follow-up rather than the cold-open decode itself, so the first
        /// paint never waits on it).
        ///
        /// Cancellable and generation-guarded: <see cref="CancelActiveDecode"/>
        /// signals <see cref="_amazeCancelFlag"/> the same way it signals the
        /// Preview decode's own flag, and the result is discarded unless
        /// <paramref name="generation"/> still matches
        /// <see cref="_decodeGeneration"/> and <paramref name="photo"/> is
        /// still the open photo when it lands — a photo switch or another
        /// decode-owned edit both bump the generation before this can apply.
        /// </summary>
        private void ScheduleAmazeUpgrade(
            int generation, PhotoItem photo, AdjustmentState model, DecodedImage previewDecoded)
        {
            if (!RefineDecodeQuality.ShouldScheduleAmazeUpgrade(
                    RenderEngine.SensorLongEdge(photo.EditPath), PreviewLongEdge))
                return;

            var amazeCancelFlag = RawFfi.maple_cancel_flag_new();
            _amazeCancelFlag = amazeCancelFlag;
            _ = Task.Run(() =>
            {
                try
                {
                    var upgraded = RenderEngine.Decode(
                        photo.EditPath, model, PreviewLongEdge, RefineDecodeQuality.Amaze,
                        amazeCancelFlag, reuseAutoProfileFrom: previewDecoded);
                    if (!RefineDecodeQuality.IsStillCurrent(generation, _decodeGeneration))
                        return;
                    // Swaps in as the new refine base AND regenerates the
                    // fast-tick session (RenderScheduler.SetImage derives the
                    // half-res session from this same image), so both phases
                    // present the upgraded detail from here on.
                    Renderer.SetImage(upgraded);
                    OnUi(() => Renderer.RequestRender(Adjustments.Clone()));
                }
                catch (Exception ex)
                {
                    // Cancelled (photo switch, another decode-owned edit) or
                    // failed — the Preview base stays on screen either way,
                    // not worth surfacing as a user-facing error.
                    DiagLog.Write($"[decode] amaze upgrade not applied: {ex.Message}");
                }
                finally
                {
                    RawFfi.maple_cancel_flag_free(amazeCancelFlag);
                }
            });
        }
    }
}
