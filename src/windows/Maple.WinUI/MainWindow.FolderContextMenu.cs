// MainWindow.FolderContextMenu.cs — sources-tree folder context flyout
// (#2647): New Folder, Rename, Move to Trash. WinUI's ContextFlyout on the
// FOLDERS TreeViewItem (MainWindow.xaml) fires on right-click, touch
// long-press, AND the keyboard context-menu key automatically — no extra
// input wiring needed for any of the three.
//
// Mirrors the established split (MainWindow.Rename.cs /
// EditSessionViewModel.Rename.cs, MainWindow.BatchRename.cs /
// EditSessionViewModel.BatchRename.cs): this file is UI-thread mechanics
// only — building the ContentDialogs, live name-validation feedback (the
// same "disable Create/Rename + show the reason inline" pattern #2643/#2645
// use), and Narrator announcements via the same RenameStatusText live
// region inline rename already uses (AnnounceRename, MainWindow.Rename.cs).
// The actual filesystem calls and tree/AppSettings reconciliation live in
// EditSessionViewModel.FolderCrud.cs.

using System;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        // --- New Folder ---

        private async void OnNewFolderInTree(object sender, RoutedEventArgs e)
        {
            if (await ResolveFolderContextTargetAsync(sender) is not { } parent)
                return;

            var nameBox = new TextBox { Header = "Folder name", PlaceholderText = "New Folder" };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(nameBox, "Folder name");
            var errorText = BuildFolderDialogErrorText();

            var dialog = new ContentDialog
            {
                Title = $"New Folder in “{parent.Name}”",
                Content = new StackPanel { Spacing = 8, Width = 360, Children = { nameBox, errorText } },
                PrimaryButtonText = "Create",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
                IsPrimaryButtonEnabled = false,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            nameBox.TextChanged += (_, _) => RefreshFolderNameValidation(dialog, errorText, nameBox.Text);

            if (await dialog.ShowAsync() != ContentDialogResult.Primary)
                return;

            var typed = nameBox.Text.Trim();
            var (ok, error) = await ViewModel.CreateFolderInTreeAsync(parent, typed);
            var message = ok ? $"Created folder {typed}." : (error ?? "Couldn't create the folder.");
            AnnounceRename(message);
            if (!ok)
                await ShowMessageAsync("New Folder", message);
        }

        // --- Rename ---

        private async void OnRenameFolderInTree(object sender, RoutedEventArgs e)
        {
            if (await ResolveFolderContextTargetAsync(sender) is not { } node)
                return;

            var nameBox = new TextBox { Header = "Folder name", Text = node.Name };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(nameBox, "Folder name");
            var errorText = BuildFolderDialogErrorText();

            var dialog = new ContentDialog
            {
                Title = $"Rename “{node.Name}”",
                Content = new StackPanel { Spacing = 8, Width = 360, Children = { nameBox, errorText } },
                PrimaryButtonText = "Rename",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            // Unlike New Folder, an untouched field starts valid (it's the
            // current name) — Rename should be enabled from the first
            // frame, same as the web sibling's rename dialog.
            nameBox.TextChanged += (_, _) => RefreshFolderNameValidation(dialog, errorText, nameBox.Text);
            RefreshFolderNameValidation(dialog, errorText, nameBox.Text);

            if (await dialog.ShowAsync() != ContentDialogResult.Primary)
                return;

            var typed = nameBox.Text.Trim();
            var previousName = node.Name;
            var (ok, error) = await ViewModel.RenameFolderInTreeAsync(node, typed);
            if (!ok)
            {
                var message = error ?? "Couldn't rename the folder.";
                AnnounceRename(message);
                await ShowMessageAsync("Rename", message);
                return;
            }
            AnnounceRename(string.Equals(previousName, typed, StringComparison.Ordinal)
                ? "Rename canceled — no change."
                : $"Renamed to {typed}.");
        }

        // --- Move to Trash ---

        private async void OnTrashFolderInTree(object sender, RoutedEventArgs e)
        {
            if (await ResolveFolderContextTargetAsync(sender) is not { } node)
                return;

            // Named up front, before the confirmation shows — the design
            // doc's "must be visible in the UI rather than silently
            // different" for the Recycle Bin vs .maple\trash split.
            var destination = FolderTreeCrudLogic.TrashDestinationDescription(
                LocalFileOperations.IsOnLocalFixedDrive(node.Path));

            var dialog = new ContentDialog
            {
                Title = "Move to Trash",
                Content = new TextBlock
                {
                    Text = $"Move “{node.Name}” and everything inside it to {destination}?",
                    TextWrapping = TextWrapping.Wrap,
                },
                PrimaryButtonText = "Move to Trash",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Close,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            if (await dialog.ShowAsync() != ContentDialogResult.Primary)
                return;

            var (ok, error) = await ViewModel.TrashFolderInTreeAsync(node);
            var message = ok ? $"Moved {node.Name} to {destination}." : (error ?? "Couldn't move the folder to Trash.");
            AnnounceRename(message);
            if (!ok)
                await ShowMessageAsync("Move to Trash", message);
        }

        // --- Shared target resolution / dialog helpers ---

        /// <summary>The FolderNode a context-flyout click targets, via the
        /// clicked MenuFlyoutItem's DataContext (WinUI flows the
        /// TreeViewItem's DataContext down through the flyout). Null — after
        /// surfacing an explanation, never a silent no-op — when the row is
        /// the "…" placeholder stub a not-yet-expanded folder shows before
        /// its real children have been enumerated (BuildFolderNode,
        /// EditSessionViewModel.Library.cs): right-clicking that exact
        /// transient row has no real folder to act on yet.</summary>
        private async Task<FolderNode?> ResolveFolderContextTargetAsync(object sender)
        {
            if ((sender as FrameworkElement)?.DataContext is not FolderNode node)
                return null;
            if (!node.IsPlaceholder)
                return node;

            await ShowMessageAsync("Folders",
                "This folder hasn't finished loading yet — try again in a moment.");
            return null;
        }

        // --- Shared name-dialog helpers ---

        private static TextBlock BuildFolderDialogErrorText() => new()
        {
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Foreground = (Microsoft.UI.Xaml.Media.SolidColorBrush)Application.Current.Resources["MapleErrorText"],
            Visibility = Visibility.Collapsed,
        };

        /// <summary>Live validation through the same shared raw-core engine
        /// (maple_validate_filename) inline single-asset rename uses —
        /// disables the confirm button and surfaces the rejection reason
        /// right under the field, per #2643/#2645's wording convention,
        /// rather than letting an obviously-bad name round-trip to disk
        /// first.</summary>
        private static void RefreshFolderNameValidation(ContentDialog dialog, TextBlock errorText, string typed)
        {
            var trimmed = typed.Trim();
            var error = trimmed.Length == 0 ? "Name can't be empty." : FilenameValidation.ValidationError(trimmed);
            errorText.Text = error ?? string.Empty;
            errorText.Visibility = error != null ? Visibility.Visible : Visibility.Collapsed;
            dialog.IsPrimaryButtonEnabled = error == null;
        }
    }
}
