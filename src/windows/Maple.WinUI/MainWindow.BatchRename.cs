using System;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>
    /// Batch-rename dialog (#2642): multi-select -> Photo menu -> "Batch
    /// Rename…" -> a template-token ContentDialog with a live before/after
    /// preview for the whole selection, applied sequentially. Built entirely
    /// in code-behind (StackPanel/Grid/TextBox), the same pattern
    /// MainWindow.Pano.cs and MainWindow.Dialogs.cs already use for
    /// multi-field dialogs — no new MainWindow.xaml markup beyond the single
    /// "Batch Rename…" menu entry.
    ///
    /// All template rendering and rename orchestration lives in
    /// EditSessionViewModel.BatchRename.cs (which wires the shared raw-core
    /// engine, Services/FilenameTemplateEngine.cs) and
    /// Services/FileOperations/BatchRenameLogic.cs (the WinUI-free,
    /// Maple.WinUI.Tests-covered preview/apply logic) — this file is UI-thread
    /// mechanics only: building the dialog, refreshing the preview list on
    /// every keystroke, and reporting the outcome (both visually and to
    /// Narrator via AnnounceRename, the same live region inline rename uses).
    /// </summary>
    public sealed partial class MainWindow
    {
        private static readonly (string Label, string Token)[] BatchRenameTokens =
        {
            ("Original name", "{original}"),
            ("Number", "{n}"),
            ("Date", "{date:%Y-%m-%d}"),
            ("Extension", "{ext}"),
        };

        private async void OnBatchRename(object sender, RoutedEventArgs e)
        {
            var selection = ViewModel.SelectedPhotos;
            var eligible = EditSessionViewModel.BatchRenameEligible(selection);
            if (eligible.Count == 0)
            {
                await ShowMessageAsync("Batch Rename",
                    "Select one or more local photos in the grid first "
                    + "(Cloud photos can't be renamed here yet — rename them from the source library).");
                return;
            }
            var skippedCloud = selection.Count - eligible.Count;
            var sources = EditSessionViewModel.BuildBatchRenameSources(eligible);

            var templateBox = new TextBox { Header = "Rename template", Text = "{original}" };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(templateBox, "Rename template");

            var tokenRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
            foreach (var (label, token) in BatchRenameTokens)
            {
                var button = new Button
                {
                    Content = label,
                    FontSize = 11,
                    Padding = new Thickness(8, 4, 8, 4),
                };
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, $"Insert {label} token");
                button.Click += (_, _) => InsertToken(templateBox, token);
                tokenRow.Children.Add(button);
            }

            var startBox = new TextBox { Header = "Start numbering at", Text = "1", Width = 150 };
            var padBox = new TextBox { Header = "Zero-pad width", Text = "0", Width = 150 };
            var numberRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
            numberRow.Children.Add(startBox);
            numberRow.Children.Add(padBox);

            var collisionCombo = new ComboBox
            {
                Header = "If a rendered name is already taken",
                HorizontalAlignment = HorizontalAlignment.Stretch,
            };
            collisionCombo.Items.Add("Add a number automatically");
            collisionCombo.Items.Add("Replace the existing file");
            collisionCombo.Items.Add("Stop and show an error");
            collisionCombo.SelectedIndex = 0;

            var summaryText = new TextBlock
            {
                FontSize = 11,
                TextWrapping = TextWrapping.Wrap,
                Foreground = (SolidColorBrush)Application.Current.Resources["MapleTextMuted"],
            };

            var previewPanel = new StackPanel { Spacing = 4 };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(previewPanel, "Batch rename preview");
            var previewScroller = new ScrollViewer { Content = previewPanel, MaxHeight = 260 };

            var dialog = new ContentDialog
            {
                Title = "Batch Rename",
                PrimaryButtonText = $"Rename {eligible.Count} Photo{(eligible.Count == 1 ? "" : "s")}",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.None,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };

            void RefreshPreview()
            {
                var start = ParseSequenceStart(startBox.Text);
                var pad = ParsePadWidth(padBox.Text);
                var rows = EditSessionViewModel.BuildBatchRenamePreview(sources, templateBox.Text, start, pad);

                previewPanel.Children.Clear();
                foreach (var row in rows)
                    previewPanel.Children.Add(BuildPreviewRow(row));

                var ready = rows.Count(r => r.WouldApply);
                summaryText.Text = BuildPreviewSummary(ready, rows.Count, skippedCloud);
                dialog.IsPrimaryButtonEnabled = ready > 0;
            }

            templateBox.TextChanged += (_, _) => RefreshPreview();
            startBox.TextChanged += (_, _) => RefreshPreview();
            padBox.TextChanged += (_, _) => RefreshPreview();
            RefreshPreview();

            var content = new StackPanel { Spacing = 10, Width = 460 };
            content.Children.Add(templateBox);
            content.Children.Add(tokenRow);
            content.Children.Add(numberRow);
            content.Children.Add(collisionCombo);
            content.Children.Add(summaryText);
            content.Children.Add(previewScroller);
            dialog.Content = new ScrollViewer { Content = content, MaxHeight = 640 };

            if (await dialog.ShowAsync() != ContentDialogResult.Primary)
                return;

            var finalStart = ParseSequenceStart(startBox.Text);
            var finalPad = ParsePadWidth(padBox.Text);
            var collision = collisionCombo.SelectedIndex switch
            {
                1 => CollisionPolicy.Replace,
                2 => CollisionPolicy.Fail,
                _ => CollisionPolicy.AutoSuffix,
            };

            await RunBatchRenameAsync(eligible, sources, templateBox.Text, finalStart, finalPad, collision);
        }

        private async System.Threading.Tasks.Task RunBatchRenameAsync(
            System.Collections.Generic.IReadOnlyList<PhotoItem> eligible,
            System.Collections.Generic.IReadOnlyList<BatchRenameSourceItem> sources,
            string template,
            ulong sequenceStart,
            int sequencePadWidth,
            CollisionPolicy collision)
        {
            var statusText = new TextBlock
            {
                Text = $"Renaming 0 of {eligible.Count}…",
                FontSize = 12,
                Width = 380,
                TextWrapping = TextWrapping.Wrap,
            };
            var progressDialog = new ContentDialog
            {
                Title = "Renaming photos…",
                Content = new StackPanel
                {
                    Spacing = 10,
                    Children = { new ProgressBar { IsIndeterminate = true }, statusText },
                },
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            var progressShown = progressDialog.ShowAsync();

            // The dialog has no Cancel affordance, so if ApplyBatchRenameAsync
            // throws something BatchRenameLogic itself didn't already turn
            // into a per-item Error outcome (FileOperationException/IOException/
            // UnauthorizedAccessException are all caught there), the modal
            // must still come down — otherwise it covers the app forever and
            // the only way out is killing the process. Teardown lives in
            // `finally`; the catch re-surfaces the failure instead of letting
            // `finally` silently swallow it.
            System.Collections.Generic.IReadOnlyList<BatchRenameItemOutcome> outcomes =
                System.Array.Empty<BatchRenameItemOutcome>();
            Exception? unexpected = null;
            try
            {
                outcomes = await ViewModel.ApplyBatchRenameAsync(
                    eligible, sources, template, sequenceStart, sequencePadWidth, collision,
                    (done, total) => OnUiThread(() => statusText.Text = $"Renaming {done} of {total}…"));
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
                AnnounceRename("Batch rename failed.");
                await ShowMessageAsync("Batch Rename failed",
                    $"An unexpected error stopped the batch partway through: {unexpected.Message}\n\n"
                    + "Photos already renamed before the error stay renamed; check the grid for what "
                    + "went through.");
                return;
            }

            var relocated = outcomes.Count(o => o.Kind == BatchRenameOutcomeKind.Relocated);
            var failed = outcomes.Count - relocated;
            var summary = failed == 0
                ? $"Renamed {relocated} photo{(relocated == 1 ? "" : "s")}."
                : $"Renamed {relocated} of {outcomes.Count} photos. {failed} failed.";
            AnnounceRename(summary);

            if (failed == 0)
            {
                await ShowMessageAsync("Batch Rename", summary);
                return;
            }

            var detail = new StackPanel { Spacing = 6 };
            foreach (var outcome in outcomes.Where(o => o.Kind != BatchRenameOutcomeKind.Relocated))
            {
                detail.Children.Add(new TextBlock
                {
                    Text = $"{outcome.OldFileName ?? "(unknown)"}: {outcome.Error ?? "unknown error"}",
                    FontSize = 12,
                    TextWrapping = TextWrapping.Wrap,
                });
            }
            var reportDialog = new ContentDialog
            {
                Title = $"Batch Rename — {summary}",
                Content = new ScrollViewer { Content = detail, MaxHeight = 320 },
                CloseButtonText = "OK",
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            await reportDialog.ShowAsync();
        }

        private static string BuildPreviewSummary(int ready, int total, int skippedCloud)
        {
            var cloudNote = skippedCloud > 0
                ? $" {skippedCloud} Cloud photo{(skippedCloud == 1 ? "" : "s")} skipped (can't rename here yet)."
                : string.Empty;
            return ready == total
                ? $"{total} photo{(total == 1 ? "" : "s")} ready to rename.{cloudNote}"
                : $"{ready} of {total} ready — rows with an error are skipped at apply time.{cloudNote}";
        }

        private static FrameworkElement BuildPreviewRow(BatchRenamePreviewRow row)
        {
            var grid = new Grid { ColumnSpacing = 8 };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var oldText = new TextBlock
            {
                Text = row.OldFileName,
                FontSize = 12,
                TextTrimming = TextTrimming.CharacterEllipsis,
                Foreground = (SolidColorBrush)Application.Current.Resources["MapleTextMuted"],
            };
            Grid.SetColumn(oldText, 0);

            var arrow = new TextBlock
            {
                Text = "→",
                FontSize = 12,
                Opacity = 0.5,
                HorizontalAlignment = HorizontalAlignment.Center,
            };
            Grid.SetColumn(arrow, 1);

            var isError = row.Error != null;
            var newText = new TextBlock
            {
                Text = isError ? (row.Error ?? string.Empty) : (row.NewFileName ?? string.Empty),
                FontSize = 12,
                TextTrimming = TextTrimming.CharacterEllipsis,
                TextWrapping = isError ? TextWrapping.Wrap : TextWrapping.NoWrap,
                Foreground = isError
                    ? new SolidColorBrush(Windows.UI.Color.FromArgb(255, 0xD1, 0x58, 0x4A))
                    : (SolidColorBrush)Application.Current.Resources["MapleTextMain"],
            };
            Grid.SetColumn(newText, 2);

            grid.Children.Add(oldText);
            grid.Children.Add(arrow);
            grid.Children.Add(newText);

            var accessibleName = isError
                ? $"{row.OldFileName}: {row.Error}"
                : $"{row.OldFileName} renames to {row.NewFileName}";
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(grid, accessibleName);
            return grid;
        }

        /// <summary>Inserts <paramref name="token"/> at the caret, REPLACING
        /// any current selection rather than leaving it in place next to the
        /// inserted token — a user who highlights part of the template
        /// (e.g. to swap `{n}` for `{date:%Y-%m-%d}`) expects the token
        /// button to behave like typing over the selection.</summary>
        private static void InsertToken(TextBox box, string token)
        {
            var text = box.Text ?? string.Empty;
            var caret = Math.Clamp(box.SelectionStart, 0, text.Length);
            var selectionLength = Math.Clamp(box.SelectionLength, 0, text.Length - caret);
            var withoutSelection = text.Remove(caret, selectionLength);
            box.Text = withoutSelection.Insert(caret, token);
            box.Select(caret + token.Length, 0);
        }

        /// <summary>Blank or unparseable -> 0 — the render engine's own
        /// `{n}` default. Not surfaced as a field error: an in-progress edit
        /// (e.g. the box briefly empty while retyping) shouldn't block the
        /// live preview from refreshing.</summary>
        private static ulong ParseSequenceStart(string? text) =>
            ulong.TryParse((text ?? string.Empty).Trim(), out var value) ? value : 0;

        /// <summary>Blank, unparseable, or negative -> 0 (no padding). A
        /// value that exceeds the engine's own MAX_SEQUENCE_PAD_WIDTH (32)
        /// is passed through unchanged — the engine rejects it per-row with
        /// the exact reason, rather than this dialog silently clamping and
        /// hiding that the user's input was too large.</summary>
        private static int ParsePadWidth(string? text) =>
            int.TryParse((text ?? string.Empty).Trim(), out var value) && value >= 0 ? value : 0;
    }
}
