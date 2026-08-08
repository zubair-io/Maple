// MainWindow.MoveToFolder.cs — the keyboard/Narrator-accessible equivalent
// to dragging a grid selection onto the sources tree (#2648's explicit
// requirement: "Narrator users cannot drag"). Reachable from the Photo menu
// ("Move to Folder…", MainWindow.xaml) with no mouse gesture required — a
// standard MenuFlyoutItem opens a ContentDialog with a destination-folder
// ListView and a Move/Copy ComboBox, both plain WinUI controls that carry
// full keyboard navigation and Narrator support for free. On confirm, this
// calls the exact same RunDragMoveAsync (MainWindow.DragDrop.cs) the drag
// gesture calls — same collision dialog, same progress dialog, same
// per-item outcome report — so the two entry points can never drift apart.
//
// Built entirely in code-behind, the same pattern MainWindow.BatchRename.cs
// uses for its own multi-field dialog — no new MainWindow.xaml markup
// beyond the single "Move to Folder…" menu entry.

using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private async void OnMoveToFolder(object sender, RoutedEventArgs e)
        {
            var selection = ViewModel.SelectedPhotos;
            var eligible = EditSessionViewModel.DragMoveEligible(selection);
            if (eligible.Count == 0)
            {
                await ShowMessageAsync("Move to Folder",
                    "Select one or more local photos in the grid first "
                    + "(Cloud photos can't be moved here yet — move them from the source library).");
                return;
            }
            var skippedCloud = selection.Count - eligible.Count;

            var folders = FlattenFolderTree(ViewModel.FolderTree);
            if (folders.Count == 0)
            {
                await ShowMessageAsync("Move to Folder",
                    "No folders are open in the FOLDERS list yet — open a folder first "
                    + "(File → Open Folder…).");
                return;
            }

            var folderLabel = new TextBlock { Text = "Destination folder", FontSize = 12 };
            var folderList = new ListView
            {
                ItemsSource = folders,
                DisplayMemberPath = nameof(FolderNode.Path),
                SelectionMode = ListViewSelectionMode.Single,
                MaxHeight = 240,
                SelectedIndex = 0,
            };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(folderList, "Destination folder");

            var modeCombo = new ComboBox
            {
                Header = "Action",
                HorizontalAlignment = HorizontalAlignment.Stretch,
            };
            modeCombo.Items.Add("Move");
            modeCombo.Items.Add("Copy");
            modeCombo.SelectedIndex = 0;

            var summaryText = new TextBlock
            {
                FontSize = 11,
                TextWrapping = TextWrapping.Wrap,
                Foreground = (SolidColorBrush)Application.Current.Resources["MapleTextMuted"],
                Text = BuildMoveToFolderSummary(eligible.Count, skippedCloud),
            };

            var content = new StackPanel { Spacing = 10, Width = 420 };
            content.Children.Add(folderLabel);
            content.Children.Add(folderList);
            content.Children.Add(modeCombo);
            content.Children.Add(summaryText);

            var dialog = new ContentDialog
            {
                Title = "Move to Folder",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
                Content = content,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };

            void RefreshPrimaryButton()
            {
                var verb = modeCombo.SelectedIndex == 1 ? "Copy" : "Move";
                dialog.PrimaryButtonText = $"{verb} {eligible.Count} Photo{(eligible.Count == 1 ? "" : "s")}";
                dialog.IsPrimaryButtonEnabled = folderList.SelectedItem != null;
            }
            modeCombo.SelectionChanged += (_, _) => RefreshPrimaryButton();
            folderList.SelectionChanged += (_, _) => RefreshPrimaryButton();
            RefreshPrimaryButton();

            if (await dialog.ShowAsync() != ContentDialogResult.Primary)
                return;
            if (folderList.SelectedItem is not FolderNode destination)
                return;

            var mode = modeCombo.SelectedIndex == 1 ? RelocateMode.Copy : RelocateMode.Move;
            await RunDragMoveAsync(eligible, destination.Path, mode);
        }

        private static string BuildMoveToFolderSummary(int eligibleCount, int skippedCloud)
        {
            var selectedText = $"{eligibleCount} photo{(eligibleCount == 1 ? "" : "s")} selected.";
            return skippedCloud > 0
                ? selectedText + $" {skippedCloud} Cloud photo{(skippedCloud == 1 ? "" : "s")} skipped "
                                + "(can't move here yet)."
                : selectedText;
        }

        /// <summary>Depth-first flatten of the FOLDERS sidebar tree, using
        /// each node's already-realized Children. Mirrors the drag-and-drop
        /// path's own reachability: a folder that has never been expanded in
        /// this session (FolderNode.ChildrenLoaded false) has no drop target
        /// to drag onto either, so this dialog deliberately offers exactly
        /// the same set — never a folder the drag gesture couldn't reach.
        /// Placeholder expander stubs are excluded.</summary>
        private static List<FolderNode> FlattenFolderTree(IEnumerable<FolderNode> roots)
        {
            var result = new List<FolderNode>();
            void Walk(IEnumerable<FolderNode> nodes)
            {
                foreach (var node in nodes)
                {
                    if (node.IsPlaceholder)
                        continue;
                    result.Add(node);
                    if (node.ChildrenLoaded)
                        Walk(node.Children);
                }
            }
            Walk(roots);
            return result;
        }
    }
}
