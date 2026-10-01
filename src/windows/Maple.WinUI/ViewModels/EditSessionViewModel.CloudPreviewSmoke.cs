using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    internal static async Task VerifySavedCloudPreviewAsync(string raw, string output)
    {
        var sidecar = Path.Combine(output, "cloud-saved-preview.xmp");
        await File.WriteAllTextAsync(sidecar, XmpWriter.Serialize(new XmpSidecarDocument
            { Adjustments = new() { Profile = ProfileMode.Neutral } }));
        using var handler = new SavedPreviewResponses(sidecar);
        using var client = new CloudClient("https://cloud-preview.invalid", handler, Path.Combine(output, "saved-cloud-cache"));
        using var session = new EditSessionViewModel(restoreSources: false) { _cloud = client };
        var photo = new PhotoItem { FilePath = "/cloud.dng", FileName = "cloud.dng", IsCloud = true, LocalCachePath = raw };
        session.SelectedPhoto = photo;
        await session._cloudSidecarLoad;
        session.Adjustments.Exposure = 1;
        session.PushCloudSidecar(photo);
        await session._cloudMetadataWrites.DrainAsync();
        await Wait(() => photo.PreviewPath != null && photo.ThumbnailPath != null);
        var first = photo.PreviewPath;
        var firstThumbnail = photo.ThumbnailPath;
        session.Adjustments.Exposure = 2;
        session.PushCloudSidecar(photo);
        await session._cloudMetadataWrites.DrainAsync();
        await Wait(() => photo.PreviewPath != first && photo.ThumbnailPath != firstThumbnail);
        if (!ReferenceEquals(photo, session.SelectedPhoto) || session._decodedPhoto != null || handler.Writes != 2)
            throw new InvalidOperationException("Saved cloud preview required navigation or editor decode");
        var acknowledged = photo.PreviewPath;
        handler.Reject = true;
        session.Adjustments.Exposure = 3;
        session.PushCloudSidecar(photo);
        try { await session._cloudMetadataWrites.DrainAsync(); throw new InvalidOperationException("Failed save was accepted"); }
        catch (InvalidOperationException error) when (error.Message.StartsWith("Pending cloud save failed:")) { }
        if (photo.PreviewPath != acknowledged || session._previewRequest != null)
            throw new InvalidOperationException("Rejected cloud save refreshed saved pixels");
        var publication = session._cloudPreviewPending ?? throw new InvalidOperationException("Acknowledged preview was not retained");
        if (XmpParser.Parse(publication.Xmp)?.Adjustments.Exposure != 2)
            throw new InvalidOperationException("Rejected save replaced the acknowledged publication");
        session.PublishPendingCloudPreview();
        session._cloudDoc!.Adjustments.Exposure = 9;
        await session._cloudPreviewPublication;
        var expectedXmp = Path.Combine(output, "expected-cloud-preview.xmp");
        var expectedJpeg = Path.Combine(output, "expected-cloud-preview.jpg");
        await File.WriteAllTextAsync(expectedXmp, publication.Xmp);
        if (Native.RawFfi.maple_render_develop_jpeg_to_file(raw, expectedXmp, 1280, 82, expectedJpeg) != 0
            || handler.Published.Count != 1
            || !System.Linq.Enumerable.SequenceEqual(handler.Published[0], await File.ReadAllBytesAsync(expectedJpeg)))
            throw new InvalidOperationException("Cloud publication used mutable or unacknowledged adjustments");

        // Retry the failed save after navigating away. Its acknowledgement
        // must publish the captured photo without borrowing the new session.
        handler.Reject = false;
        session.SelectedPhoto = null;
        await session._cloudMetadataWrites.DrainAsync(retryFailed: true);
        await Wait(() => handler.Published.Count == 2);
        await session._cloudPreviewPublication;
        if (session._cloudPreviewPending != null)
            throw new InvalidOperationException("Late cloud acknowledgement waited for another navigation");

        session.SelectedPhoto = photo;
        await session._cloudSidecarLoad;
        var beforeTransfer = photo.PreviewPath;
        var beforeTransferThumbnail = photo.ThumbnailPath;
        var transferred = new XmpSidecarDocument
            { Adjustments = new() { Profile = ProfileMode.Neutral, Exposure = 4 }, Rating = 4, Flag = "pick" };
        await File.WriteAllTextAsync(sidecar, XmpWriter.Serialize(transferred));
        await session.RefreshAfterTransferAsync(photo);
        await Wait(() => photo.PreviewPath != beforeTransfer && photo.ThumbnailPath != beforeTransferThumbnail);
        if (session.Adjustments.Exposure != 4 || photo.Rating != 4 || photo.FlagStatus != "pick")
            throw new InvalidOperationException("Cloud transfer did not refresh adjustments and metadata");
        // A metadata-only transfer must not take the unchanged-adjustments exit
        // before publishing its acknowledged rating and flag.
        transferred.Rating = 2;
        transferred.Flag = "reject";
        await File.WriteAllTextAsync(sidecar, XmpWriter.Serialize(transferred));
        await session.RefreshAfterTransferAsync(photo);
        if (photo.Rating != 2 || photo.FlagStatus != "reject")
            throw new InvalidOperationException("Metadata-only cloud transfer retained stale metadata");
        await Wait(() => session._previewRequest == null);

        static async Task Wait(Func<bool> ready)
        {
            var timer = Stopwatch.StartNew();
            while (!ready() && timer.Elapsed < TimeSpan.FromSeconds(60)) await Task.Delay(20);
            if (!ready()) throw new InvalidOperationException("Cloud save did not refresh preview and thumbnail");
        }
    }

    private sealed class SavedPreviewResponses(string sidecar) : HttpMessageHandler
    {
        public int Writes;
        public bool Reject;
        public readonly List<byte[]> Published = new();
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
        {
            if (request.Method == HttpMethod.Put && request.RequestUri?.AbsolutePath == "/api/preview")
            {
                Published.Add(await request.Content!.ReadAsByteArrayAsync(cancellation));
                return new(HttpStatusCode.OK);
            }
            if (request.RequestUri?.AbsolutePath != "/api/xmp") throw new InvalidOperationException("Unexpected saved-preview route");
            if (request.Method == HttpMethod.Post)
            {
                if (Reject) return new(HttpStatusCode.ServiceUnavailable);
                await File.WriteAllTextAsync(sidecar, await request.Content!.ReadAsStringAsync(cancellation), cancellation);
                Writes++;
            }
            return new(HttpStatusCode.OK) { Content = new StringContent(await File.ReadAllTextAsync(sidecar, cancellation)) };
        }
    }
}
