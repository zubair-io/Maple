using System;
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
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
        {
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
