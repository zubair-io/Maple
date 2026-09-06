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
