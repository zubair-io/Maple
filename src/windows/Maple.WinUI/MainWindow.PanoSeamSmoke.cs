using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Pano;
using Maple.WinUI.Views;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    /// <summary>The seam editor in the real window, and the bundled maple-cli
    /// refusing regions on Tile (#5992). The smoke fixture is one flat grey
    /// frame, which cannot be aligned into a panorama, so the preview canvas
    /// the regions are drawn on is planted and no panorama is composited.</summary>
    private async Task VerifyPanoSeamsAsync(string raw, string output)
    {
        var root = Content as Grid ?? throw new InvalidOperationException("Seam qualification requires the root Grid.");
        var folder = Directory.CreateDirectory(System.IO.Path.Combine(output, "pano-seams")).FullName;
        var second = System.IO.Path.Combine(folder, "frame-b.dng");
        File.Copy(raw, second, overwrite: true);
        var frames = new[] { raw, second };
        var authoring = new PanoSeamAuthoring();
        var editor = new PanoSeamEditor(authoring);
        var box = new Grid { Width = 460, Height = 200 };
        box.Children.Add(editor.Overlay.Root);
        var host = new StackPanel
        {
            Width = 460,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Top,
        };
        host.Children.Add(box);
        host.Children.Add(editor.Root);
        root.Children.Add(host);

        Control Named(string id) => HslDescendants(host).OfType<Control>()
            .Single(control => AutomationProperties.GetAutomationId(control) == id);
        bool Shows(string text) => HslDescendants(editor.Root).OfType<TextBlock>()
            .Any(block => block.Text == text && block.Visibility == Visibility.Visible);
        void Require(bool held, string failure)
        {
            if (!held) throw new InvalidOperationException($"Seam editor: {failure}");
        }
        async Task SettleAsync()
        {
            await Task.Delay(50);
            root.UpdateLayout();
        }
        async Task InvokeAsync(string name)
        {
            var invoke = FrameworkElementAutomationPeer.CreatePeerForElement(Named(name))
                ?.GetPattern(PatternInterface.Invoke) as IInvokeProvider
                ?? throw new InvalidOperationException($"Seam editor: {name} has no Invoke pattern.");
            invoke.Invoke();
            await Task.Delay(100);
            await SettleAsync();
        }
        void Plant(string strategy, string resolved = "rotation")
        {
            authoring.GeometryChanged(strategy);
            authoring.PreviewRequested();
            authoring.PreviewCompleted(new PanoPreviewCompletion(
                new PanoPreviewRun(new PanoPreviewOptions("keep", "mesh", strategy),
                    new PanoPreviewFiles(System.IO.Path.Combine(folder, "planted.png"), System.IO.Path.Combine(folder, "planted.json")), null),
                new PanoPreviewOutcome(true, false, null,
                    new PanoPreviewReport(new PanoSeamCanvas(2048, 1024), resolved, "solved", frames, null))), isLatest: true);
            authoring.ImageShown(0);
        }

        try
        {
            await SettleAsync();
            var names = new[]
            {
                PanoSeamIds.Frame, PanoSeamIds.Kind, PanoSeamIds.X, PanoSeamIds.Y, PanoSeamIds.Width,
                PanoSeamIds.Height, PanoSeamIds.Add, PanoSeamIds.Clear, PanoSeamIds.Preview,
            };
            Require(names.All(name => Named(name).ActualHeight > 0 && AutomationProperties.GetName(Named(name)).Length > 0),
                "a control is missing or has no accessible name");
            Require(HslDescendants(editor.Root).OfType<StackPanel>().Any(panel =>
                AutomationProperties.GetAutomationId(panel) == PanoSeamIds.List
                && AutomationProperties.GetName(panel) == PanoSeamText.ListName),
                "the region list has no accessible name");
            Require(!Named(names[6]).IsEnabled && !Named(names[2]).IsEnabled && Shows(PanoSeamAuthoring.WaitReason),
                "authoring was open before any preview");

            Plant("auto");
            await SettleAsync();
            Require(Named(names[6]).IsEnabled && !Shows(PanoSeamAuthoring.WaitReason), "a current preview did not open authoring");
            ((TextBox)Named(PanoSeamIds.X)).Text = "100";
            ((TextBox)Named(PanoSeamIds.Y)).Text = "200";
            ((TextBox)Named(PanoSeamIds.Width)).Text = "80";
            ((TextBox)Named(PanoSeamIds.Height)).Text = "60";
            await InvokeAsync(names[6]);
            var typed = new PanoSeamRegion(PanoSeamKind.Include, 0, new PanoSeamRect(100, 200, 80, 60));
            Require(authoring.Regions.SequenceEqual(new[] { typed }), "typed coordinates did not add the region");
            var surface = editor.Overlay.Surface;
            var outline = surface.Children.OfType<Rectangle>().Single();
            Require(Math.Abs(surface.Width - 400) < 0.5 && Math.Abs(surface.Height - 200) < 0.5
                && Math.Abs(Canvas.GetLeft(outline) - 100 * 400.0 / 2048) < 0.5
                && Math.Abs(Canvas.GetTop(outline) - 200 * 200.0 / 1024) < 0.5
                && Math.Abs(outline.Width - 80 * 400.0 / 2048) < 0.5,
                "the region is not drawn where it sits on the preview");

            ((ComboBox)Named(PanoSeamIds.Frame)).SelectedIndex = 1;
            ((ComboBox)Named(PanoSeamIds.Kind)).SelectedIndex = 1;
            Require(editor.Overlay.BeginDrag(new Point(200, 100)), "a drag did not start on the preview");
            editor.Overlay.MoveDrag(new Point(240, 120));
            editor.Overlay.EndDrag();
            await SettleAsync();
            var dragged = new PanoSeamRegion(PanoSeamKind.Exclude, 1, new PanoSeamRect(1024, 512, 205, 103));
            Require(authoring.Regions.SequenceEqual(new[] { typed, dragged }), "a drag did not add the excluded region");
            Require(Named(PanoSeamIds.Remove(0)).ActualHeight > 0 && Named(PanoSeamIds.Remove(1)).ActualHeight > 0,
                "a listed region has no Remove button");

            ((TextBox)Named(PanoSeamIds.X)).Text = "abc";
            await InvokeAsync(names[6]);
            Require(authoring.Regions.Count == 2 && Shows(PanoSeamAuthoring.InvalidNumbers), "invalid coordinates were not reported");

            var request = authoring.Request ?? throw new InvalidOperationException("Seam editor: regions produced no request.");
            var provisioner = new PanoProvisioner(AppSettings.Load());
            Require(provisioner.CliPresent, "maple-cli.exe is not beside the app");
            var run = new PanoPreviewRun(new PanoPreviewOptions("keep", "mesh", "tile"),
                new PanoPreviewFiles(System.IO.Path.Combine(folder, "preview-1.png"), System.IO.Path.Combine(folder, "alignment-1.json")),
                null, request);
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            var outcome = await Task.Run(() => PanoService.PreviewAsync(
                provisioner, frames, run, PanoFeatureEngine.Classical, _ => { }, limit.Token));
            Require(!outcome.Ok && (outcome.Error ?? string.Empty).StartsWith(PanoCliReport.InvalidSeamConstraints + ": ", StringComparison.Ordinal)
                && outcome.Error!.Contains("graph-cut", StringComparison.Ordinal)
                && !File.Exists(run.Files.PreviewPng)
                && File.ReadAllText(run.Files.SeamConstraintsJson) == request.ToJson(),
                $"maple-cli did not refuse regions on Tile by name: {outcome.Error}");
            authoring.PreviewRequested();
            var verdict = authoring.PreviewCompleted(new PanoPreviewCompletion(run, outcome), isLatest: true);
            editor.ShowMessage(verdict.Message);
            await SettleAsync();
            Require(Shows(outcome.Error!) && authoring.Regions.Count == 2 && authoring.CanAuthor,
                "the refusal was not shown by name with the regions kept");

            await InvokeAsync(PanoSeamIds.Remove(0));
            Require(authoring.Regions.SequenceEqual(new[] { dragged }), "Remove did not drop exactly its region");
            await InvokeAsync(names[7]);
            Require(authoring.Regions.Count == 0 && !Named(names[7]).IsEnabled, "Clear left regions behind");

            ((TextBox)Named(PanoSeamIds.X)).Text = "100";
            await InvokeAsync(names[6]);
            authoring.GeometryChanged("rotation");
            await SettleAsync();
            Require(authoring.Regions.Count == 0 && !Named(names[6]).IsEnabled && Shows(PanoSeamAuthoring.WaitReason)
                && surface.Visibility == Visibility.Collapsed, "a geometry change left stale regions editable");
            Plant("tile");
            await SettleAsync();
            Require(!Named(names[6]).IsEnabled && Shows(PanoSeamAuthoring.TileReason), "Tile did not close authoring");
            Plant("auto", "tile");
            await SettleAsync();
            Require(!Named(names[6]).IsEnabled && Shows(PanoSeamAuthoring.TileReason), "Auto resolving to Tile did not close authoring");

            await File.WriteAllTextAsync(System.IO.Path.Combine(output, "pano-seams.json"), JsonSerializer.Serialize(new
            {
                passed = true,
                scope = "seam editor in the real window on a planted 2048x1024 preview canvas; bundled maple-cli refusal; no panorama composited",
                request = request.ToJson(),
                refusal = outcome.Error,
                cli = provisioner.CliPath,
            }));
        }
        finally { root.Children.Remove(host); }
    }
}
