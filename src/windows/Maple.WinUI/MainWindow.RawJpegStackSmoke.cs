using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Threading.Tasks;
using Maple.UI;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    // A 16x16 baseline JPEG: the qualification needs a same-stem JPEG the app can decode, not a photograph.
    private const string RawJpegStackSmokeJpegBase64 =
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxO" +
        "UlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09P" +
        "T09PT09PT0//wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF" +
        "BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW" +
        "V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi" +
        "4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC" +
        "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm" +
        "Z2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq" +
        "8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooorQg//Z";

    private static readonly TimeSpan RawJpegStackSmokeWait = TimeSpan.FromSeconds(20);

    private async Task VerifyRawJpegStackAsync(string raw, string output)
    {
        var folder = Path.Combine(output, "raw-jpeg-stack");
        if (Directory.Exists(folder))
            throw new InvalidOperationException("RAW+JPEG stack qualification requires a fresh folder.");
        if (!Services.FileOperations.RawJpegPairing.IsRaw(raw))
            throw new InvalidOperationException($"The smoke input {raw} is not a RAW the pairing rule folds.");

        var rawName = "Stack-1" + Path.GetExtension(raw);
        const string jpegName = "Stack-1.jpg";
        var (rawCopy, jpegCopy) = (Path.Combine(folder, rawName), Path.Combine(folder, jpegName));
        var originals = new[] { raw, rawCopy, jpegCopy };
        var selected = ViewModel.SelectedPhoto;
        var (previousFolder, previousMode, previousSwitch) =
            (ViewModel.CurrentFolderPath, _mode, AppSettings.Load().ShowRawJpegStacks);
        var root = (FrameworkElement)Content;
        Exception? failure = null;
        try
        {
            var hashesBefore = await Task.Run(() =>
            {
                Directory.CreateDirectory(folder);
                File.Copy(raw, rawCopy);
                File.WriteAllBytes(jpegCopy, Convert.FromBase64String(RawJpegStackSmokeJpegBase64));
                return originals.Select(HashRawJpegStackSmokeFile).ToArray();
            });

            SetRawJpegStackSwitch(true);
            await ViewModel.LoadDirectoryAsync(folder).WaitAsync(RawJpegStackSmokeWait);
            SetMode(ShellMode.Browse);
            await WaitForRawJpegStackSmokeAsync(
                () => ViewModel.Photos.Count == 1 && ViewModel.AllPhotos.Count == 2,
                $"the pair did not fold to one tile (tiles={ViewModel.Photos.Count}, files={ViewModel.AllPhotos.Count})");

            var tile = ViewModel.Photos[0];
            if (!string.Equals(tile.FilePath, rawCopy, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(tile.StackCompanion?.FilePath, jpegCopy, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"The tile is {tile.FilePath} with JPEG {tile.StackCompanion?.FilePath}.");

            PhotoGrid.ScrollIntoView(tile);
            FrameworkElement? container = null;
            await WaitForRawJpegStackSmokeAsync(() =>
            {
                root.UpdateLayout();
                container = PhotoGrid.ContainerFromItem(tile) as FrameworkElement;
                return container != null;
            }, "the stacked tile was not realized");
            var visuals = RawJpegStackSmokeVisuals(container!).ToList();
            var captions = visuals.OfType<TextBlock>().Select(text => text.Text).ToList();
            if (!captions.Contains("RAW+JPEG"))
                throw new InvalidOperationException($"The tile has no RAW+JPEG badge (texts: {string.Join(" | ", captions)}).");
            if (captions.Any(text => text == rawName || text == jpegName))
                throw new InvalidOperationException("The stacked tile still carries a filename caption.");
            var expectedName = $"{rawName} and {jpegName}";
            var accessibleNames = visuals.OfType<FrameworkElement>().Append(container!)
                .Select(AutomationProperties.GetName).Where(name => name.Length > 0).ToList();
            if (!accessibleNames.Contains(expectedName))
                throw new InvalidOperationException(
                    $"No tile element is named \"{expectedName}\" (names: {string.Join(" | ", accessibleNames)}).");

            ViewModel.SelectedPhoto = tile;
            RefreshPhotoInfo();
            var infoRows = FileRows.Children.OfType<MuiLabelValueGrid>()
                .SelectMany(grid => grid.Rows ?? Array.Empty<MuiLabelValueRow>()).ToList();
            if (!infoRows.Any(row => row.Label == "JPEG" && row.Value.Contains(jpegName, StringComparison.Ordinal)))
                throw new InvalidOperationException(
                    $"Info does not list the JPEG (rows: {string.Join(" | ", infoRows.Select(row => row.Label + "=" + row.Value))}).");

            SetRawJpegStackSwitch(false);
            await WaitForRawJpegStackSmokeAsync(
                () => ViewModel.Photos.Count == 2 && ViewModel.AllPhotos.All(photo => photo.StackCompanion == null && photo.StackPrimary == null),
                $"turning the switch off did not split the pair (tiles={ViewModel.Photos.Count})");
            SetRawJpegStackSwitch(true);
            await WaitForRawJpegStackSmokeAsync(
                () => ViewModel.Photos.Count == 1, "turning the switch back on did not fold the pair");

            var hashesAfter = await Task.Run(() => originals.Select(HashRawJpegStackSmokeFile).ToArray());
            if (!hashesBefore.SequenceEqual(hashesAfter))
                throw new InvalidOperationException("RAW+JPEG stack qualification changed an original file.");
        }
        catch (Exception error)
        {
            failure = error;
        }

        try
        {
            SetRawJpegStackSwitch(previousSwitch);
            if (!string.IsNullOrEmpty(previousFolder) && Directory.Exists(previousFolder))
                await ViewModel.LoadDirectoryAsync(previousFolder).WaitAsync(RawJpegStackSmokeWait);
            ViewModel.SelectedPhoto = selected;
            SetMode(previousMode);
        }
        catch (Exception cleanup) when (failure == null)
        {
            failure = cleanup;
        }
        catch (Exception)
        {
            // The assertion that failed first is the one to report.
        }
        if (failure != null)
            ExceptionDispatchInfo.Capture(failure).Throw();
    }

    private void SetRawJpegStackSwitch(bool shown)
    {
        if (SettingsWindow.ApplyRawJpegStacks(ViewModel, shown) is { } error)
            throw new InvalidOperationException(error);
    }

    private static async Task WaitForRawJpegStackSmokeAsync(Func<bool> condition, string failure)
    {
        var deadline = Environment.TickCount64 + (long)RawJpegStackSmokeWait.TotalMilliseconds;
        while (!condition())
        {
            if (Environment.TickCount64 >= deadline)
                throw new TimeoutException($"RAW+JPEG stack: {failure}");
            await Task.Delay(50);
        }
    }

    private static string HashRawJpegStackSmokeFile(string path) =>
        Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    private static IEnumerable<DependencyObject> RawJpegStackSmokeVisuals(DependencyObject parent)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            yield return child;
            foreach (var descendant in RawJpegStackSmokeVisuals(child))
                yield return descendant;
        }
    }
}
