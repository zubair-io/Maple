// MuiSyncGate — a tiny re-entrancy gate (#3435 review): while a
// programmatic model->UI sync is running, a control's own "the user
// changed this" event must be suppressed rather than routed back into the
// host as a real edit. WinUI-free (no Microsoft.UI.Xaml dependency) so it
// stays directly unit-testable even though the ContentControl that uses it
// (MuiMaskPanel) cannot itself be constructed outside a live XAML app.
//
// The concrete bug this guards against (Jules review on PR #3435):
// MuiMaskPanel.SyncControlValues() pushes the selected layer's values into
// eleven MuiDragBar controls and the invert MuiCheckbox by setting their
// Value/IsChecked properties. A WinUI ToggleButton (which MuiCheckbox
// derives from) raises its own Checked/Unchecked routed events on ANY
// IsChecked change, programmatic sets included — so without a guard, every
// layer selection or ModelSynced call would round-trip the synced value
// back out through InvertChanged, and MainWindow.Mask.cs would write it
// straight back into the model via NotifyAdjustmentEdited(), restarting
// the undo-boundary timer and the sidecar debounce on every selection even
// though nothing the user did actually changed.

using System;

namespace Maple.UI
{
    public sealed class MuiSyncGate
    {
        private int _depth;

        /// <summary>True while a <see cref="RunSynced"/> call (or a nested
        /// one) is in progress.</summary>
        public bool IsSyncing => _depth > 0;

        /// <summary>Runs <paramref name="apply"/> with <see cref="IsSyncing"/>
        /// true for its duration. A depth counter (not a bool) so a nested
        /// sync — one DP callback's write triggering another's — still
        /// reports syncing until the OUTERMOST call finishes, and the
        /// depth is restored via `finally` even if `apply` throws.</summary>
        public void RunSynced(Action apply)
        {
            _depth++;
            try
            {
                apply();
            }
            finally
            {
                _depth--;
            }
        }
    }
}
