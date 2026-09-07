using System;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    /// <summary>
    /// White-balance picker actions (#2434): the neutral eyedropper, the
    /// nine-choice preset picker and the provenance readout. Every action is
    /// ONE undo transaction — the pair and its provenance land together, the
    /// same shape as SelectProfile — and a result that arrives after the
    /// photo or the model moved on is dropped with a message rather than
    /// written over the user's work (Apple `WhiteBalancePicker.pick`, web
    /// `sampleWhiteBalanceInto`).
    /// </summary>
    public partial class EditSessionViewModel
    {
        /// <summary>Bumped by every arm/cancel/land so a late result from a
        /// superseded analysis is ignored.</summary>
        private int _wbAnalysisGeneration;

        [ObservableProperty]
        private bool _isWhiteBalanceSampling;

        /// <summary>The actionable line under the picker: a rejection, a
        /// stale-result notice, or null.</summary>
        [ObservableProperty]
        private string? _whiteBalanceMessage;

        /// <summary>Raised after a sample landed on the model — the canvas
        /// eyedropper disarms on it.</summary>
        public event Action? WhiteBalanceSampled;

        public string WhiteBalanceProvenanceText => WhiteBalanceProvenance.ProvenanceText(Adjustments);

        public string SelectedWhiteBalancePreset => WhiteBalanceProvenance.SelectedPresetName(Adjustments);

        /// <summary>The eyedropper needs the RAW original; a rendered
        /// JPEG/TIFF has no scene-linear neutral to solve.</summary>
        public bool CanSampleWhiteBalance =>
            SelectedPhoto is { } photo && WhiteBalanceSampler.IsRawPath(photo.EditPath);

        /// <summary>Sample the neutral at a normalised point in the uncropped,
        /// display-oriented frame and commit it as one edit.</summary>
        public void SampleWhiteBalance(double nx, double ny)
        {
            var photo = SelectedPhoto;
            if (photo == null || IsWhiteBalanceSampling)
                return;
            if (!WhiteBalanceSampler.IsRawPath(photo.EditPath))
            {
                WhiteBalanceMessage = WhiteBalanceSampler.MessageFor(WhiteBalanceSampleFailure.UnsupportedAsset);
                return;
            }
            var before = Adjustments.Clone();
            var beforeText = ModelText(before);
            var generation = ++_wbAnalysisGeneration;
            IsWhiteBalanceSampling = true;
            WhiteBalanceMessage = null;
            _ = Task.Run(() =>
            {
                try
                {
                    var sample = WhiteBalanceSampler.Sample(photo.EditPath, before, nx, ny);
                    OnUi(() => LandWhiteBalanceResult(
                        generation, photo, beforeText,
                        state => WhiteBalanceProvenance.MarkSampled(
                            state, sample.Temperature, sample.Tint, nx, ny, sample.AlgorithmVersion),
                        "The photo changed while sampling. Pick the neutral area again.",
                        sampled: true));
                }
                catch (WhiteBalanceSampleException ex)
                {
                    DiagLog.Write($"[wb] sample rejected: {ex.Failure} {ex.Detail}");
                    OnUi(() => FailWhiteBalanceResult(generation, ex.Message));
                }
                catch (Exception ex)
                {
                    DiagLog.Write($"[wb] sample failed: {ex}");
                    OnUi(() => FailWhiteBalanceResult(
                        generation, WhiteBalanceSampler.MessageFor(WhiteBalanceSampleFailure.Failed)));
                }
            });
        }

        /// <summary>Drop any in-flight analysis and clear the message.</summary>
        public void CancelWhiteBalanceSample()
        {
            _wbAnalysisGeneration++;
            IsWhiteBalanceSampling = false;
            WhiteBalanceMessage = null;
        }

        /// <summary>
        /// One of the nine `crs:WhiteBalance` names. Auto runs the AUTO
        /// estimator and applies only its white-balance pair (tone and AE
        /// stay); As Shot restores the camera pair; the six illuminants write
        /// their generated pair; Custom keeps the pair and reads as Manual.
        /// Re-selecting the displayed choice is a no-op that leaves redo
        /// intact.
        /// </summary>
        public void ApplyWhiteBalancePreset(string name)
        {
            var photo = SelectedPhoto;
            if (photo == null)
                return;
            CancelWhiteBalanceSample();
            if (name == WhiteBalancePresets.Auto)
            {
                AutoWhiteBalance(photo);
                return;
            }
            if (name == WhiteBalancePresets.AsShot)
            {
                ApplyWhiteBalanceEdit(
                    state => WhiteBalanceProvenance.ApplyAsShot(state, _asShotTemperature, _asShotTint),
                    normalizeBefore: NormalizeLegacyAsShot);
                return;
            }
            ApplyWhiteBalanceEdit(state => WhiteBalanceProvenance.ApplyNamedPreset(state, name));
        }

        private void AutoWhiteBalance(PhotoItem photo)
        {
            var before = Adjustments.Clone();
            var beforeText = ModelText(before);
            var generation = ++_wbAnalysisGeneration;
            IsWhiteBalanceSampling = true;
            _ = Task.Run(() =>
            {
                // EstimateAuto is total, but the same shape as
                // SampleWhiteBalance: nothing thrown here may leave the
                // busy flag set and the picker locked (#3443 review).
                (double Temperature, double Tint)? pair = null;
                try
                {
                    pair = WhiteBalanceSampler.EstimateAuto(photo.EditPath, before);
                }
                catch (Exception ex)
                {
                    DiagLog.Write($"[wb] auto white balance faulted: {ex}");
                }
                finally
                {
                    var landed = pair;
                    OnUi(() =>
                    {
                        if (landed is not { } p)
                        {
                            FailWhiteBalanceResult(generation, WhiteBalanceSampler.AutoFailureMessage);
                            return;
                        }
                        LandWhiteBalanceResult(
                            generation, photo, beforeText,
                            state =>
                            {
                                state.Temperature = p.Temperature;
                                state.Tint = p.Tint;
                                WhiteBalanceProvenance.MarkAuto(state);
                            },
                            "The photo changed during analysis. Choose Auto again.",
                            sampled: false);
                    });
                }
            });
        }

        private void LandWhiteBalanceResult(
            int generation, PhotoItem photo, string beforeText, Action<AdjustmentState> edit,
            string staleMessage, bool sampled)
        {
            if (generation != _wbAnalysisGeneration)
                return;
            IsWhiteBalanceSampling = false;
            if (!ReferenceEquals(photo, SelectedPhoto) || ModelText(Adjustments) != beforeText)
            {
                WhiteBalanceMessage = staleMessage;
                return;
            }
            ApplyWhiteBalanceEdit(edit);
            if (sampled)
                WhiteBalanceSampled?.Invoke();
        }

        private void FailWhiteBalanceResult(int generation, string message)
        {
            if (generation != _wbAnalysisGeneration)
                return;
            IsWhiteBalanceSampling = false;
            WhiteBalanceMessage = message;
        }

        /// <summary>Older sidecars carry As Shot provenance with the name
        /// omitted; selecting the displayed As Shot must not record an edit
        /// (Swift <c>resetToAsShot</c>).</summary>
        private static AdjustmentState NormalizeLegacyAsShot(AdjustmentState state)
        {
            if (state.WbSource != WbSource.AsShot || state.WhiteBalancePreset != WhiteBalancePresets.Custom)
                return state;
            var normalized = state.Clone();
            normalized.WhiteBalancePreset = WhiteBalancePresets.AsShot;
            return normalized;
        }

        /// <summary>Apply <paramref name="edit"/> as one undo transaction:
        /// finish any pending slider gesture, record the boundary, and skip
        /// entirely (redo preserved) when nothing would change.</summary>
        private void ApplyWhiteBalanceEdit(
            Action<AdjustmentState> edit, Func<AdjustmentState, AdjustmentState>? normalizeBefore = null)
        {
            var before = Adjustments.Clone();
            var beforeText = ModelText(before);
            var candidate = before.Clone();
            edit(candidate);
            var comparand = normalizeBefore?.Invoke(before) ?? before;
            if (ModelText(candidate) == ModelText(comparand))
                return;

            _undoTimer?.Dispose();
            _undoTimer = null;
            if (_undoBaseline != null && ModelText(_undoBaseline) != beforeText)
                CommitUndoBoundary();

            edit(Adjustments);
            CommitUndoBoundary();
            AfterModelReplaced(before);
        }

        private static string ModelText(AdjustmentState state) =>
            XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = state });
    }
}
