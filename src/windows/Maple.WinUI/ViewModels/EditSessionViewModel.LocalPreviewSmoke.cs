using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Services.Transfer;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    internal static async Task VerifyLocalPreviewAsync(string fixture)
    {
        var sidecar = SidecarStore.SidecarPathFor(fixture);
        var baseline = new AdjustmentState { Profile = ProfileMode.Neutral, Exposure = 2 };
        File.WriteAllText(sidecar, XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = baseline }));
        using var session = new EditSessionViewModel(restoreSources: false);
        var photo = new PhotoItem { FilePath = fixture, FileName = Path.GetFileName(fixture) };
        var followingPath = Path.Combine(Path.GetDirectoryName(fixture)!, "following-unedited.dng");
        File.Copy(fixture, followingPath);
        var following = new PhotoItem { FilePath = followingPath, FileName = Path.GetFileName(followingPath) };
        var authoredBlockedFollowing = false;
        photo.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(PhotoItem.ThumbnailPath) && photo.ThumbnailPath != null
                && following.ThumbnailPath == null) authoredBlockedFollowing = true;
        };
        await session.HydrateLibraryAsync(new List<PhotoItem> { photo, following }, null, CancellationToken.None);
        if (authoredBlockedFollowing || following.ThumbnailPath == null)
            throw new InvalidOperationException("Cold authored development blocked the following unedited thumbnail");
        await Wait(() => photo.ThumbnailPath != null, "Cold library hydration did not publish edited thumbnail");
        var coldThumbnail = photo.ThumbnailPath;
        if (!coldThumbnail!.Contains("edited-") || !coldThumbnail.EndsWith(".thumb.png"))
            throw new InvalidOperationException("Cold library used embedded pixels for an edited photo");
        session.SelectedPhoto = photo;
        await Wait(() => photo.PreviewPath != null, "Cold edited selection did not publish a preview");
        var cold = photo.PreviewPath;
        if (session._decodedPhoto != null || !cold!.Contains("edited-"))
            throw new InvalidOperationException("Cold Browse preview depends on opening Editor");
        session.Adjustments.Exposure = 1;
        session.ScheduleSidecarWrite();
        session.FlushSidecarNow();
        await Wait(() => photo.PreviewPath != null && photo.PreviewPath != cold && session._previewRequest == null,
            "Saved adjustment did not refresh Browse");
        var changed = photo.PreviewPath;
        if (Digest(changed!).SequenceEqual(Digest(cold!)))
            throw new InvalidOperationException("Saved exposure did not change preview content");
        if (photo.ThumbnailPath == coldThumbnail)
            throw new InvalidOperationException("Saved adjustment did not refresh grid/filmstrip");
        File.WriteAllText(sidecar, XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = baseline }));
        session.OnSidecarChangedOnDisk(null, sidecar);
        await Wait(() => photo.PreviewPath != null && photo.PreviewPath != changed && session._previewRequest == null,
            "External sidecar reset did not refresh preview");
        if (!Digest(photo.PreviewPath!).SequenceEqual(Digest(cold!))
            || photo.ThumbnailPath == null || !Digest(photo.ThumbnailPath).SequenceEqual(Digest(coldThumbnail)))
            throw new InvalidOperationException("External sidecar reset did not restore preview and thumbnail content");
        cold = photo.PreviewPath;
        coldThumbnail = photo.ThumbnailPath;

        // Requests are issued on the UI thread in one turn. Their dispatcher
        // completions cannot publish until after the selection is replaced.
        var abandoned = new PhotoItem { FilePath = fixture, FileName = photo.FileName };
        session.SelectedPhoto = abandoned;
        session.SelectedPhoto = photo;
        await Wait(() => session._previewRequest == null, "Latest preview request did not settle");
        if (abandoned.PreviewPath != null || photo.PreviewPath != cold)
            throw new InvalidOperationException("Stale selection published an edited preview");

        session.SelectedPhoto = null;
        session.AllPhotos.Add(photo);
        var snapshot = await TransferSnapshot.ReadAsync(fixture, null, CancellationToken.None);
        var incoming = baseline.Clone();
        incoming.Exposure = 1;
        var patch = AdjustmentTransfer.Build(new(incoming, snapshot.Document.WbScaleVersion, null), new[] { "tone" });
        var job = await LocalTransferJob.CreateAsync(Path.Combine(Path.GetDirectoryName(fixture)!, "thumbnail-transfer"),
            new[] { new TransferJobInput(fixture, photo.FileName, snapshot.ExpectedHash!, patch) });
        var result = await job.RunAsync(false, CancellationToken.None);
        if (result.Applied != 1) throw new InvalidOperationException("Thumbnail transfer fixture failed");
        await session.RefreshLocalTransferThumbnailsAsync(job);
        if (photo.ThumbnailPath == coldThumbnail || session.SelectedPhoto != null)
            throw new InvalidOperationException("Unselected transfer target did not refresh its thumbnail");
        // A later external edit must not be mistaken for the journal's write.
        File.WriteAllText(sidecar, XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = baseline }));
        var transferredThumbnail = photo.ThumbnailPath;
        await session.RefreshLocalTransferThumbnailsAsync(job);
        if (photo.ThumbnailPath != transferredThumbnail)
            throw new InvalidOperationException("Stale transfer checkpoint refreshed an externally changed target");

        static byte[] Digest(string uri) => SHA256.HashData(File.ReadAllBytes(new Uri(uri).LocalPath));

        static async Task Wait(Func<bool> ready, string error)
        {
            var timer = Stopwatch.StartNew();
            while (!ready() && timer.Elapsed < TimeSpan.FromSeconds(60)) await Task.Delay(20);
            if (!ready()) throw new InvalidOperationException(error);
        }
    }
}
