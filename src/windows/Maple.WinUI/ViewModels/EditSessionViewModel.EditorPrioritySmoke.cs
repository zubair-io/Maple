using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    internal async Task VerifyEditorPreviewPriorityAsync(string raw, string output, Action<ShellMode> setMode)
    {
        var originalPhoto = SelectedPhoto
            ?? throw new InvalidOperationException("Editor priority requires an open photo");
        var directory = Directory.CreateDirectory(Path.Combine(output, "editor-priority")).FullName;
        var editedPath = Path.Combine(directory, "edited.dng");
        var nextPath = Path.Combine(directory, "next.dng");
        var barePath = Path.Combine(directory, "bare.dng");
        File.Copy(raw, editedPath);
        File.Copy(raw, nextPath);
        File.Copy(raw, barePath);
        var sourceHash = SHA256.HashData(File.ReadAllBytes(raw));
        File.WriteAllText(SidecarStore.SidecarPathFor(editedPath), XmpWriter.Serialize(new XmpSidecarDocument
            { Adjustments = new AdjustmentState { Profile = ProfileMode.Neutral, Exposure = 2 } }));
        var edited = new PhotoItem { FilePath = editedPath, FileName = "edited.dng", Format = "DNG" };
        var next = new PhotoItem { FilePath = nextPath, FileName = "next.dng", Format = "DNG" };
        var bare = new PhotoItem { FilePath = barePath, FileName = "bare.dng", Format = "DNG" };
        AllPhotos.Add(edited);
        AllPhotos.Add(next);
        AllPhotos.Add(bare);
        var completed = false;
        try
        {
            setMode(ShellMode.Edit);
            SelectedPhoto = edited;
            Require(_previewRequest == null, "opening a photo in Edit started a saved preview");
            Require(Math.Abs(Adjustments.Exposure - 2) < 1e-6 && Adjustments.Profile == ProfileMode.Neutral,
                "saved adjustments were not loaded");
            await EditorReady(edited);
            Require(_previewRequest == null && edited.PreviewPath == null && edited.ThumbnailPath == null,
                "the editor's open requested or published a saved preview");

            Save(1);
            Require(_previewRequest == null && edited.PreviewPath == null,
                "a save in Edit restarted the saved preview");

            setMode(ShellMode.Preview);
            Require(_previewRequest != null, "leaving Edit did not start the owed saved preview");
            await Wait(() => _previewRequest == null && edited.PreviewPath != null && edited.ThumbnailPath != null,
                "the owed saved preview was not published after leaving Edit");
            var published = edited.PreviewPath;
            var publishedThumbnail = edited.ThumbnailPath;
            var developed = await _thumbnails.GetOrCreateAdjustedPreviewAsync(
                editedPath, Adjustments, CancellationToken.None);
            Require(developed != null && published == new Uri(developed).AbsoluteUri
                && publishedThumbnail!.Contains("edited-"),
                "the preview published after Edit is not the saved develop");

            Save(.5);
            var obsolete = _previewRequest
                ?? throw new InvalidOperationException("a save in Preview did not refresh the saved preview");
            setMode(ShellMode.Edit);
            Require(obsolete.IsCancellationRequested && _previewRequest == null,
                "entering Edit left the saved preview running");

            Save(.25);
            SelectedPhoto = next;
            Require(_previewRequest == null, "selecting a photo in Edit started a saved preview");
            await EditorReady(next);
            Require(edited.PreviewPath == published && edited.ThumbnailPath == publishedThumbnail
                && next.PreviewPath == null && next.ThumbnailPath == null && _previewRequest == null,
                "a saved preview was published while the shell stayed in Edit");

            setMode(ShellMode.Preview);
            Require(_previewRequest != null, "leaving Edit did not refresh the selected photo");
            Require(edited.PreviewPath == null && _owedThumbnails != null,
                "the photo edited earlier was not queued for its owed refresh");
            setMode(ShellMode.Edit);
            Require(_previewRequest == null && _owedThumbnails == null,
                "returning to Edit left owed refreshes running");
            setMode(ShellMode.Preview);
            await Wait(() => _previewRequest == null && next.ThumbnailPath != null
                && edited.ThumbnailPath != publishedThumbnail,
                "derivatives owed from Edit were not refreshed");
            var savedThumbnail = await _thumbnails.GetOrCreateAdjustedThumbnailAsync(
                editedPath, SavedAdjustments(editedPath), CancellationToken.None);
            Require(savedThumbnail != null && edited.ThumbnailPath == new Uri(savedThumbnail).AbsoluteUri,
                "the thumbnail of the photo edited earlier is not its saved develop");

            setMode(ShellMode.Edit);
            SelectedPhoto = bare;
            Require(_previewRequest != null, "a photo without a sidecar was not given its embedded placeholder in Edit");
            await Wait(() => _previewRequest == null, "the embedded placeholder request did not finish in Edit");

            Require(Math.Abs(SavedAdjustments(editedPath).Exposure - .25) < 1e-6,
                "autosave was changed by deferring the saved preview");
            Require(new[] { editedPath, nextPath, barePath, raw }.All(path =>
                    sourceHash.SequenceEqual(SHA256.HashData(File.ReadAllBytes(path)))),
                "an original was modified");
            completed = true;
        }
        finally
        {
            AllPhotos.Remove(edited);
            AllPhotos.Remove(next);
            AllPhotos.Remove(bare);
            setMode(ShellMode.Edit);
            SelectedPhoto = originalPhoto;
            // After a failed stage the restore must not replace the assertion that failed.
            try { await EditorReady(originalPhoto); }
            catch (InvalidOperationException) when (!completed) { }
        }

        void Save(double exposure)
        {
            Adjustments.Exposure = exposure;
            NotifyAdjustmentEdited();
            FlushSidecarNow();
        }

        async Task EditorReady(PhotoItem photo)
        {
            EnsureDecoded();
            await Wait(() => HasDecodeError || (!IsDecoding && Renderer.DetailSource != null),
                $"the editor did not decode {photo.FileName}");
            Require(!HasDecodeError && ReferenceEquals(_decodedPhoto, photo),
                $"the editor failed to decode {photo.FileName}: {DecodeStatus}");
        }

        static AdjustmentState SavedAdjustments(string path) =>
            SidecarStore.Load(path)?.Adjustments
                ?? throw new InvalidOperationException("Editor priority: the sidecar was not saved");

        static void Require(bool condition, string failure)
        {
            if (!condition) throw new InvalidOperationException("Editor priority: " + failure);
        }

        static async Task Wait(Func<bool> ready, string failure)
        {
            var timer = Stopwatch.StartNew();
            while (!ready() && timer.Elapsed < TimeSpan.FromSeconds(20)) await Task.Delay(20);
            Require(ready(), failure);
        }
    }
}
