using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;

namespace Maple.WinUI
{
    /// <summary>Global keyboard shortcuts: rating/culling, grid/preview/edit
    /// navigation, rename, delete-to-trash, undo/redo, zoom, export, and the
    /// mode transitions the E/Escape keys drive. Bound once, from the root
    /// content's KeyDown in the constructor, and gated off the currently
    /// focused element so a TextBox (inline rename, search) gets first
    /// crack at every key.</summary>
    public sealed partial class MainWindow
    {
        // --- Keyboard (culling + navigation + edit) ---

        private void OnRootKeyDown(object sender, KeyRoutedEventArgs e)
        {
            // A modal's buttons and result list can hold focus too. Root
            // culling/navigation shortcuts must not mutate the frozen selection.
            if (_modalFlowGate.IsEntered) return;
            if (FocusManager.GetFocusedElement(this.Content.XamlRoot) is TextBox or Slider or NumberBox or ComboBox)
                return;
            var ctrl = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
            var shift = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
            if (!ctrl && _mode == ShellMode.Edit && e.Key is VirtualKey.B or (VirtualKey)0xDC)
            {
                _compare.Press(System.Environment.TickCount64);
                UpdateComparison();
                e.Handled = true;
                return;
            }

            var key = (int)e.Key;
            if (!ctrl && key >= (int)VirtualKey.Number0 && key <= (int)VirtualKey.Number5)
            {
                ViewModel.SetRating(key - (int)VirtualKey.Number0);
                UpdateStarRow();
                e.Handled = true;
                return;
            }

            e.Handled = true;
            switch (e.Key)
            {
                case VirtualKey.P when !ctrl: ViewModel.SetFlag("pick"); break;
                case VirtualKey.X when !ctrl: ViewModel.SetFlag("reject"); break;
                case VirtualKey.U when !ctrl: ViewModel.SetFlag("none"); break;
                case VirtualKey.Left: ViewModel.SelectNeighbor(-1); break;
                case VirtualKey.Right: ViewModel.SelectNeighbor(1); break;
                case VirtualKey.Up when _mode != ShellMode.Browse: ViewModel.SelectNeighbor(-10); break;
                case VirtualKey.Down when _mode != ShellMode.Browse: ViewModel.SelectNeighbor(10); break;
                case VirtualKey.Enter when _mode == ShellMode.Browse: EnterPreview(); break;
                // ListViewBase.SelectAll — valid because PhotoGrid is
                // SelectionMode="Extended" (it throws only in Single/None).
                case VirtualKey.A when ctrl && _mode == ShellMode.Browse:
                    if (_browseListDetail) BrowsePhotoList.SelectAll(); else PhotoGrid.SelectAll();
                    break;
                // Inline rename (#2639): same "sole selection, else resolved
                // primary target" rule Enter uses to open a photo — see
                // ResolveRenameTarget's doc comment.
                case VirtualKey.F2 when _mode == ShellMode.Browse:
                    if (ViewModel.ResolveRenameTarget() is { } renameTarget)
                        StartRename(renameTarget);
                    break;
                // Delete → Trash (#2654): same OnDeleteSelectedPhotos entry
                // point as the Photo menu's "Delete…" item and the grid's
                // right-click ContextFlyout. Fire-and-forget from a
                // synchronous key handler, same shape as every other
                // async-dialog entry point reachable from this switch.
                case VirtualKey.Delete when _mode == ShellMode.Browse:
                    _ = RunDeleteSelectedPhotosAsync();
                    break;
                case VirtualKey.E when !ctrl && _mode == ShellMode.Preview:
                    SetMode(ShellMode.Edit);
                    ViewModel.EnsureDecoded();
                    break;
                case VirtualKey.Escape when _wbPickArmed: CancelWhiteBalancePick(); break;
                case VirtualKey.Escape when _mode == ShellMode.Edit && _showScopes: OnCloseScopes(this, new Microsoft.UI.Xaml.RoutedEventArgs()); break;
                case VirtualKey.Escape when _mode == ShellMode.Edit: SetMode(ShellMode.Preview); break;
                case VirtualKey.Escape when _mode == ShellMode.Preview: SetMode(ShellMode.Browse); break;
                case VirtualKey.Number0 when ctrl && _mode != ShellMode.Browse:
                    ResetZoom();
                    break;
                case VirtualKey.Number1 when ctrl && _mode != ShellMode.Browse:
                    _ = SetActualSizeAsync();
                    break;
                case (VirtualKey)0xBB when ctrl && _mode != ShellMode.Browse:  // '=' / '+'
                    SetZoom(ViewerScroll.ZoomFactor * 1.5f);
                    break;
                case (VirtualKey)0xBD when ctrl && _mode != ShellMode.Browse:  // '-'
                    SetZoom(ViewerScroll.ZoomFactor / 1.5f);
                    break;
                case VirtualKey.Z when ctrl && shift: ViewModel.Redo(); break;
                case VirtualKey.C when ctrl && shift: OnCopySettings(this, new RoutedEventArgs()); break;
                case VirtualKey.V when ctrl && shift: OnPasteSettings(this, new RoutedEventArgs()); break;
                case VirtualKey.Z when ctrl: ViewModel.Undo(); break;
                case VirtualKey.R when ctrl: ViewModel.RevertToOriginal(); break;
                case VirtualKey.E when ctrl: OnExportPhotos(this, new RoutedEventArgs()); break;
                case VirtualKey.O when ctrl: OnOpenDirectory(this, new RoutedEventArgs()); break;
                // Maple.UI control library showcase (dev/design tool, not a
                // product surface) — smallest clean insertion into the
                // existing key-handling switch, same shape as every other
                // entry point here.
                case VirtualKey.G when ctrl && shift: new Maple.UI.Gallery.MuiGalleryWindow().Activate(); break;
                default: e.Handled = false; break;
            }
        }
    }
}
