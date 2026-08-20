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
            WireFolderNameErrorAccessibility(nameBox, errorText);

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
            // Review finding: without this, initial keyboard focus lands on
            // the Primary button (disabled or not) rather than the field the
            // user actually needs to type into.
            dialog.Opened += (_, _) => nameBox.Focus(FocusState.Programmatic);

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
            WireFolderNameErrorAccessibility(nameBox, errorText);

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
            // Same focus fix as New Folder, plus select-all so typing
            // immediately replaces the seeded current name (matches
            // FocusRenameField's inline single-asset rename convention,
            // MainWindow.Rename.cs).
            dialog.Opened += (_, _) =>
            {
                nameBox.Focus(FocusState.Programmatic);
                nameBox.SelectAll();
            };

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

            // Checked BEFORE the confirmation even shows (review finding: a
            // library root with no real Recycle Bin available — an SMB
            // root, or any root on a drive a Recycle Bin call can't reach —
            // always failed after confirming, which is its own kind of
            // silent-failure trap; refuse up front with the reason
            // instead).
            var (canTrash, blockedReason, isOnLocalFixedDrive) = await ViewModel.CanTrashFolderAsync(node);
            if (!canTrash)
            {
                var reason = blockedReason ?? "This folder can't be moved to Trash.";
                AnnounceRename(reason);
                await ShowMessageAsync("Move to Trash", reason);
                return;
            }

            // Named up front, before the confirmation shows — the design
            // doc's "must be visible in the UI rather than silently
            // different" for the Recycle Bin vs .maple\trash split. Reuses
            // CanTrashFolderAsync's own drive-type result (#2948) rather
            // than making a second synchronous DriveInfo call here.
            var destination = FolderTreeCrudLogic.TrashDestinationDescription(isOnLocalFixedDrive);

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
            // Review finding: DefaultButton only governs what Enter
            // activates — WinUI still puts INITIAL keyboard focus on the
            // Primary button (here, the destructive "Move to Trash") when
            // Content isn't itself focusable, regardless of DefaultButton.
            // Move focus onto Close/Cancel once the dialog's own focus scope
            // is up, same fix applied to every dialog in this file.
            dialog.Opened += (_, _) => FocusCloseButton(dialog);
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

        // --- Shared focus / dialog helpers ---

        /// <summary>Moves initial keyboard focus off ContentDialog's default
        /// target — WinUI puts it on the Primary button whenever Content
        /// isn't itself focusable, REGARDLESS of DefaultButton (review
        /// finding: DefaultButton only controls what Enter activates) — onto
        /// the named Close-button template part, so a keyboard/Narrator user
        /// opening a destructive confirmation never lands on the destructive
        /// action first. "CloseButton" is the x:Name WinUI's own default
        /// ContentDialog style gives that part; FindName resolves template
        /// parts once the template has applied, which `Opened` guarantees.</summary>
        private static void FocusCloseButton(ContentDialog dialog)
        {
            if (dialog.FindName("CloseButton") is Control closeButton)
                closeButton.Focus(FocusState.Programmatic);
        }

        // --- Shared name-dialog helpers ---

        private static TextBlock BuildFolderDialogErrorText() => new()
        {
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Foreground = (Microsoft.UI.Xaml.Media.SolidColorBrush)Application.Current.Resources["MapleErrorText"],
            Visibility = Visibility.Collapsed,
        };

        /// <summary>Review finding: the error text was visible but silent to
        /// Narrator. LiveSetting=Polite makes a Text change on
        /// <paramref name="errorText"/> announce itself automatically — the
        /// same mechanism RenameStatusText/AnnounceRename already rely on
        /// (MainWindow.Rename.cs) — and DescribedBy associates the field
        /// with its error so exploring the field on demand also surfaces
        /// it, not just a live announcement at the moment it appears.</summary>
        private static void WireFolderNameErrorAccessibility(TextBox nameBox, TextBlock errorText)
        {
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetLiveSetting(
                errorText, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
            Microsoft.UI.Xaml.Automation.AutomationProperties.GetDescribedBy(nameBox).Add(errorText);
        }

        /// <summary>Live validation through the same shared raw-core engine
        /// (maple_validate_filename) inline single-asset rename uses —
        /// disables the confirm button and surfaces the rejection reason
        /// right under the field, per #2643/#2645's wording convention,
        /// rather than letting an obviously-bad name round-trip to disk
        /// first. Only reassigns errorText.Text when it actually changed —
        /// a live-region re-announces on every assignment even when the
        /// value is identical (AnnounceRename's own comment notes the same
        /// behavior), so re-typing into an already-invalid field wouldn't
        /// otherwise re-announce the same message on every keystroke.</summary>
        private static void RefreshFolderNameValidation(ContentDialog dialog, TextBlock errorText, string typed)
        {
            var trimmed = typed.Trim();
            var error = trimmed.Length == 0 ? "Name can't be empty." : FilenameValidation.ValidationError(trimmed);
            var text = error ?? string.Empty;
            if (errorText.Text != text)
                errorText.Text = text;
            errorText.Visibility = error != null ? Visibility.Visible : Visibility.Collapsed;
            dialog.IsPrimaryButtonEnabled = error == null;
        }
    }
}
