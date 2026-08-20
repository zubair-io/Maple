// MainWindow.TrashRestore.cs — the minimal in-app restore surface for
// `.maple/trash/<rel>` (#2654). Recycle-Bin items restore through Windows
// Explorer, not here (LocalFileOperations.Trash.cs's header explains why —
// the OS owns that semantics); this dialog only ever lists items Maple
// itself trashed: SMB shares (no reliable per-share recycle bin), and any
// local delete where the Recycle Bin call itself failed. Reachable from
// File → "Restore from Maple Trash…" (MainWindow.xaml) — not
// selection-scoped, since a trashed photo is no longer part of any grid
// selection to select.
//
// Built entirely in code-behind with a plain DisplayMemberPath ListView —
// the same low-risk pattern MainWindow.MoveToFolder.cs's destination-folder
// list already uses — rather than a custom DataTemplate, so there's no new
// XAML markup for this dialog at all.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        // Same reentrancy hazard, same fix, as MainWindow.Trash.cs's
        // _deleteGate — see that field's comment.
        private readonly SingleFlightGate _restoreGate = new();

        private async void OnRestoreFromMapleTrash(object sender, RoutedEventArgs e)
        {
            if (!_restoreGate.TryEnter())
                return;
            try
            {
                await RunRestoreFromMapleTrashAsync();
            }
            finally
            {
                _restoreGate.Exit();
            }
        }

        private async Task RunRestoreFromMapleTrashAsync()
        {
            var items = await ViewModel.ListMapleTrashAsync();
            if (items.Count == 0)
            {
                await ShowMessageAsync("Restore from Maple Trash",
                    "Maple's trash is empty. (Photos deleted from a local drive go to the Windows "
                    + "Recycle Bin instead — restore those from File Explorer.)");
                return;
            }

            var list = new ListView
            {
                ItemsSource = items,
                DisplayMemberPath = nameof(TrashListItem.DisplayLabel),
                SelectionMode = ListViewSelectionMode.Multiple,
                MaxHeight = 320,
            };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(list, "Trashed photos");

            var summaryText = new TextBlock
            {
                FontSize = 11,
                TextWrapping = TextWrapping.Wrap,
                Foreground = (SolidColorBrush)Application.Current.Resources["MapleTextMuted"],
                Text = $"{items.Count} item{(items.Count == 1 ? "" : "s")} in Maple's trash. Restoring a "
                    + "photo that already has a file at its original location adds \".restored\" to the "
                    + "name instead of overwriting it.",
            };

            var dialog = new ContentDialog
            {
                Title = "Restore from Maple Trash",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Close,
                Content = new StackPanel { Spacing = 10, Width = 460, Children = { summaryText, list } },
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };

            void RefreshPrimaryButton()
            {
                var count = list.SelectedItems.Count;
                dialog.PrimaryButtonText = count == 0 ? "Restore" : $"Restore {count}";
                dialog.IsPrimaryButtonEnabled = count > 0;
            }
            list.SelectionChanged += (_, _) => RefreshPrimaryButton();
            RefreshPrimaryButton();

            if (await dialog.ShowAsync() != ContentDialogResult.Primary)
                return;

            var selected = list.SelectedItems.OfType<TrashListItem>().ToList();
            if (selected.Count == 0)
                return;

            await RunRestoreAsync(selected);
        }

        private async Task RunRestoreAsync(IReadOnlyList<TrashListItem> selected)
        {
            var statusText = new TextBlock
            {
                Text = $"Restoring 0 of {selected.Count}…",
                FontSize = 12,
                Width = 380,
                TextWrapping = TextWrapping.Wrap,
            };
            var progressDialog = new ContentDialog
            {
                Title = "Restoring photos…",
                Content = new StackPanel
                {
                    Spacing = 10,
                    Children = { new ProgressBar { IsIndeterminate = true }, statusText },
                },
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            var progressShown = progressDialog.ShowAsync();

            IReadOnlyList<RestoreItemOutcome> outcomes = Array.Empty<RestoreItemOutcome>();
            Exception? unexpected = null;
            try
            {
                outcomes = await ViewModel.ApplyRestoreAsync(selected,
                    (done, total) => OnUiThread(() => statusText.Text = $"Restoring {done} of {total}…"));
            }
            catch (Exception ex)
            {
                unexpected = ex;
            }
            finally
            {
                progressDialog.Hide();
                await progressShown;
            }

            if (unexpected != null)
            {
                AnnounceRename("Restore failed.");
                await ShowMessageAsync("Restore failed",
                    $"An unexpected error stopped the restore partway through: {unexpected.Message}\n\n"
                    + "Photos already restored before the error stay restored.");
                return;
            }

            await ReportRestoreOutcomeAsync(outcomes);
        }

        private async Task ReportRestoreOutcomeAsync(IReadOnlyList<RestoreItemOutcome> outcomes)
        {
            var restored = outcomes.Count(o => o.Ok);
            var failed = outcomes.Count - restored;
            var summary = failed == 0
                ? $"Restored {restored} photo{(restored == 1 ? "" : "s")}."
                : $"Restored {restored} of {outcomes.Count} photos. {failed} failed.";
            AnnounceRename(summary);

            if (failed == 0)
            {
                await ShowMessageAsync("Restore from Maple Trash", summary);
                return;
            }

            var detail = new StackPanel { Spacing = 6 };
            foreach (var outcome in outcomes.Where(o => !o.Ok))
            {
                detail.Children.Add(new TextBlock
                {
                    Text = $"{outcome.FileName ?? "(unknown)"}: {outcome.Error ?? "unknown error"}",
                    FontSize = 12,
                    TextWrapping = TextWrapping.Wrap,
                });
            }
            var reportDialog = new ContentDialog
            {
                Title = $"Restore — {summary}",
                Content = new ScrollViewer { Content = detail, MaxHeight = 320 },
                CloseButtonText = "OK",
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            await reportDialog.ShowAsync();
        }
    }
}
