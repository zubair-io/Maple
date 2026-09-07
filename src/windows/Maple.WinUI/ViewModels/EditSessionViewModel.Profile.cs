using System;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        /// <summary>A profile choice is one discrete, undoable edit. Finish
        /// any pending slider gesture before recording the profile change.</summary>
        public void SelectProfile(ProfileMode profile)
        {
            if (SelectedPhoto == null || Adjustments.Profile == profile
                || !Enum.IsDefined(profile))
                return;

            _undoTimer?.Dispose();
            _undoTimer = null;
            var before = Adjustments.Clone();
            if (_undoBaseline != null
                && XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = _undoBaseline })
                    != XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = before }))
                CommitUndoBoundary();

            Adjustments.Profile = profile;
            CommitUndoBoundary();
            AfterModelReplaced(before);
        }

        /// <summary>Apply an edit to a DECODE-OWNED field — capture sharpening
        /// Amount / Sigma (#3414) — as ONE discrete, undoable edit.
        ///
        /// These fields are baked into the decoded base, so the per-tick slider
        /// path cannot carry them: <see cref="NotifyAdjustmentEdited"/> only
        /// re-runs the GPU chain over the base it already has. Their rows
        /// therefore park the drag (<see cref="AdjustmentSliderViewModel
        /// .CommitOnRelease"/>) and land here once, on release — the same shape
        /// <see cref="SelectProfile"/> uses, and the same commit-on-release
        /// contract the web editor gives the pair.</summary>
        public void ApplyDecodeFieldEdit(Action<AdjustmentState> apply)
        {
            if (SelectedPhoto == null)
                return;

            _undoTimer?.Dispose();
            _undoTimer = null;
            var before = Adjustments.Clone();
            // Close any earlier quiet-timer edit first, so this gesture is its
            // own undo entry rather than merging with whatever preceded it.
            if (_undoBaseline != null
                && XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = _undoBaseline })
                    != XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = before }))
                CommitUndoBoundary();

            apply(Adjustments);
            CommitUndoBoundary();
            AfterModelReplaced(before);
        }

        private void AfterModelReplaced(AdjustmentState before)
        {
            SyncSlidersFromModel();
            ScheduleSidecarWrite();
            RefreshRenderAfterModelChange(before);
        }

        private void RefreshRenderAfterModelChange(AdjustmentState before)
        {
            var photo = SelectedPhoto;
            if (photo != null && RenderEngine.DecodeInputsChanged(before, Adjustments))
            {
                // The old base includes the previous profile's AE anchor and
                // fitted tail. Never present that base with the new intent.
                Renderer.SetImage(null);
                DecodeCurrent(photo);
                return;
            }
            Renderer.RequestRender(Adjustments.Clone());
        }
    }
}
