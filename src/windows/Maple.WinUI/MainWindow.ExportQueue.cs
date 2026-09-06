using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Maple.WinUI.Services.Export;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task ShowExportQueueAsync(string? selectedId)
    {
        var jobs = await Task.Run(() => _exportStore!.ListJobs());
        var choices = new ComboBox { Header = "Saved export jobs", HorizontalAlignment = HorizontalAlignment.Stretch };
        foreach (var job in jobs)
            choices.Items.Add(new ComboBoxItem
            {
                Content = $"{job.CreatedAt.ToLocalTime():g} · {job.RecipeName} · {job.Total} photos", Tag = job.Id,
            });
        var summary = new TextBlock { TextWrapping = TextWrapping.Wrap };
        AutomationProperties.SetLiveSetting(summary, AutomationLiveSetting.Polite);
        var details = new TextBlock { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
        var cancel = new Button { Content = "Cancel remaining exports", IsEnabled = false };
        var panel = new StackPanel { Spacing = 12, Width = 470 };
        panel.Children.Add(choices);
        panel.Children.Add(summary);
        panel.Children.Add(new ScrollViewer { Content = details, MaxHeight = 310 });
        panel.Children.Add(cancel);
        panel.Children.Add(new TextBlock
        {
            Text = "One photo renders at a time. Cancellation finishes the current render without publishing it. "
                + "Completed files stay in place; resume continues pending work and retry targets only failed items.",
            TextWrapping = TextWrapping.Wrap,
        });
        var dialog = new ContentDialog
        {
            Title = "Export queue", Content = panel, PrimaryButtonText = "Run / resume",
            SecondaryButtonText = "Retry failed", CloseButtonText = "Close",
            XamlRoot = (Content as FrameworkElement)?.XamlRoot,
        };
        CancellationTokenSource? cancellation = null;
        var running = false;
        var selectionRevision = 0;
        void Show(ExportQueuePresentation view)
        {
            summary.Text = view.Summary;
            details.Text = view.Details;
            dialog.IsPrimaryButtonEnabled = !running && view.Remaining > 0;
            dialog.IsSecondaryButtonEnabled = !running && view.Failed > 0;
        }
        void RequestCancel()
        {
            cancellation?.Cancel();
            cancel.IsEnabled = false;
            summary.Text = "Cancelling after the current render…";
        }
        cancel.Click += (_, _) => RequestCancel();
        dialog.Closing += (_, args) =>
        {
            if (running) { args.Cancel = true; RequestCancel(); }
        };
        void WindowClosed(object sender, WindowEventArgs args) => cancellation?.Cancel();
        Closed += WindowClosed;
        choices.SelectionChanged += async (_, _) =>
        {
            var revision = ++selectionRevision;
            if (choices.SelectedItem is not ComboBoxItem { Tag: string id }) return;
            try
            {
                var job = await Task.Run(() => _exportStore!.Load(id));
                if (revision == selectionRevision) Show(ExportQueuePresentation.Capture(job));
            }
            catch (Exception error) { summary.Text = error.Message; }
        };
        async Task Run(bool retry)
        {
            if (running || choices.SelectedItem is not ComboBoxItem { Tag: string id }) return;
            running = true;
            ++selectionRevision;
            choices.IsEnabled = false;
            dialog.IsPrimaryButtonEnabled = dialog.IsSecondaryButtonEnabled = false;
            cancellation = new CancellationTokenSource();
            cancel.IsEnabled = true;
            ExportQueueJob? final = null;
            try
            {
                final = await _exportRunner!.RunAsync(id, retry, cancellation.Token, job =>
                {
                    // Copy before dispatch: the worker mutates its ledger while the UI is queued.
                    var snapshot = ExportQueuePresentation.Capture(job);
                    DispatcherQueue.TryEnqueue(() =>
                    {
                        if (running) Show(snapshot);
                    });
                });
            }
            catch (Exception error) { summary.Text = $"Export queue: {error.Message}"; }
            finally
            {
                running = false;
                choices.IsEnabled = true;
                cancel.IsEnabled = false;
                cancellation.Dispose();
                cancellation = null;
                if (final != null) Show(ExportQueuePresentation.Capture(final));
                else
                {
                    dialog.IsPrimaryButtonEnabled = true;
                    dialog.IsSecondaryButtonEnabled = true;
                }
            }
        }
        dialog.PrimaryButtonClick += async (_, args) => { args.Cancel = true; await Run(false); };
        dialog.SecondaryButtonClick += async (_, args) => { args.Cancel = true; await Run(true); };
        if (jobs.Count == 0)
        {
            summary.Text = "No saved export jobs. Select photos and add an export recipe to the queue.";
            dialog.IsPrimaryButtonEnabled = dialog.IsSecondaryButtonEnabled = false;
        }
        else choices.SelectedItem = choices.Items.OfType<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == selectedId)
            ?? choices.Items[0];
        try { await dialog.ShowAsync(); }
        finally { Closed -= WindowClosed; cancellation?.Cancel(); }
    }
}
