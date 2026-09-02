using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>Thin action shims: Edit-panel actions (auto/reset/revert,
    /// slider double-tap reset), pick/reject culling, and the Menu bar's
    /// mirror of the same actions plus the mode/zoom/rating items the
    /// shortcut table also drives (zoom and mode items are inert in
    /// Browse, same as the equivalent keys).</summary>
    public sealed partial class MainWindow
    {
        // --- Edit actions ---

        private void OnSliderRowDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            if (sender is FrameworkElement { DataContext: AdjustmentSliderViewModel slider })
                slider.Reset();
        }

        private void OnApplyAuto(object sender, RoutedEventArgs e) => ViewModel.ApplyAuto();
        private void OnResetAll(object sender, RoutedEventArgs e) => ViewModel.ResetToDefaults();
        private void OnRevert(object sender, RoutedEventArgs e) => ViewModel.RevertToOriginal();

        // --- Culling ---

        private void OnFlagPick(object sender, RoutedEventArgs e) => ViewModel.SetFlag("pick");
        private void OnFlagReject(object sender, RoutedEventArgs e) => ViewModel.SetFlag("reject");

        // --- Menu (#2586) — thin shims over the same actions the shortcut
        //     table drives; zoom items are inert in Browse like the keys. ---

        private void OnMenuExit(object sender, RoutedEventArgs e) => Close();
        private void OnMenuUndo(object sender, RoutedEventArgs e) => ViewModel.Undo();
        private void OnMenuRedo(object sender, RoutedEventArgs e) => ViewModel.Redo();
        private void OnMenuModeBrowse(object sender, RoutedEventArgs e) => SetMode(ShellMode.Browse);

        private void OnMenuModePreview(object sender, RoutedEventArgs e)
        {
            if (ViewModel.SelectedPhoto != null)
                SetMode(ShellMode.Preview);
        }

        private void OnMenuZoomFit(object sender, RoutedEventArgs e)
        {
            if (_mode != ShellMode.Browse)
                ResetZoom();
        }

        private void OnMenuZoomOneToOne(object sender, RoutedEventArgs e)
        {
            if (_mode != ShellMode.Browse)
                SetZoom(OneToOneZoomFactor());
        }

        private void OnMenuZoomIn(object sender, RoutedEventArgs e)
        {
            if (_mode != ShellMode.Browse)
                SetZoom(ViewerScroll.ZoomFactor * 1.5f);
        }

        private void OnMenuZoomOut(object sender, RoutedEventArgs e)
        {
            if (_mode != ShellMode.Browse)
                SetZoom(ViewerScroll.ZoomFactor / 1.5f);
        }

        private void OnMenuRating(object sender, RoutedEventArgs e)
        {
            if (sender is FrameworkElement { Tag: string tag } && int.TryParse(tag, out var stars))
            {
                ViewModel.SetRating(stars);
                UpdateStarRow();
            }
        }

        private void OnMenuFlagPick(object sender, RoutedEventArgs e) => ViewModel.SetFlag("pick");
        private void OnMenuFlagReject(object sender, RoutedEventArgs e) => ViewModel.SetFlag("reject");
        private void OnMenuFlagUnflag(object sender, RoutedEventArgs e) => ViewModel.SetFlag("none");
    }
}
