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
    // Called only by the explicit native --lifecycle-smoke diagnostic. This
    // exercises the production open/decode/history paths on the real dispatcher.
    internal static async Task VerifyCloudOpeningAsync(string raw, string output)
    {
        using var handler = new OpeningResponses();
        using var client = new CloudClient("https://cloud-opening.invalid", handler, Path.Combine(output, "cloud-cache"));
        var session = new EditSessionViewModel(restoreSources: false) { _cloud = client };
        PhotoItem Photo(string name) => new() { FilePath = "/fixtures/" + name, FileName = name,
            IsCloud = true, LocalCachePath = raw, Format = "DNG" };
        static void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException("Cloud opening: " + message);
        }
        static HttpResponseMessage Saved(double exposure) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(XmpWriter.Serialize(new XmpSidecarDocument
            { Adjustments = new() { Profile = ProfileMode.Neutral, Exposure = exposure } })),
        };
        try
        {
            var delayed = handler.Next();
            var first = Photo("delayed.dng");
            session.SelectedPhoto = first;
            var opening = session._cloudSidecarLoad;
            session.EnsureDecoded();
            Require(!session.AdjustmentsReady && session._decodedPhoto == null, "decoded before saved adjustments arrived");
            session.ApplyDecodeFieldEdit(model => model.Exposure = 9);
            session.SelectProfile(ProfileMode.Neutral);
            session.ResetToDefaults();
            session.Undo();
            Require(session.Adjustments.Exposure == 0 && session.Adjustments.Profile == ProfileMode.Auto
                && !session._sidecarDirty, "editing was enabled during loading");
            delayed.SetResult(Saved(1.25));
            await opening;
            var deadline = Stopwatch.StartNew();
            while (session._decodedPhoto != first && deadline.Elapsed < TimeSpan.FromSeconds(10)) await Task.Delay(10);
            Require(session.AdjustmentsReady && session.Adjustments.Exposure == 1.25 && session._decodedPhoto == first,
                "cached original did not wait for and use the saved adjustments");

            var failed = handler.Next();
            session.SelectedPhoto = Photo("retry.dng");
            opening = session._cloudSidecarLoad;
            failed.SetResult(new(HttpStatusCode.ServiceUnavailable));
            await opening;
            Require(!session.AdjustmentsReady && session.HasSidecarLoadError && session.SidecarLoadError.Length > 0,
                "failed sidecar was treated as defaults");
            var recovered = handler.Next();
            var retry = session.RetryCloudSidecarAsync();
            recovered.SetResult(Saved(2.5));
            await retry;
            Require(session.AdjustmentsReady && !session.HasSidecarLoadError && session.Adjustments.Exposure == 2.5,
                "retry did not restore saved adjustments");

            var stale = handler.Next();
            session.SelectedPhoto = Photo("stale.dng");
            var staleOpening = session._cloudSidecarLoad;
            var current = handler.Next();
            session.SelectedPhoto = Photo("current.dng");
            opening = session._cloudSidecarLoad;
            current.SetResult(Saved(3.5));
            await opening;
            stale.SetResult(Saved(9));
            await staleOpening;
            Require(session.AdjustmentsReady && session.Adjustments.Exposure == 3.5, "late response replaced a new photo");

            var absent = handler.Next();
            session.SelectedPhoto = Photo("missing.dng");
            opening = session._cloudSidecarLoad;
            absent.SetResult(new(HttpStatusCode.NotFound));
            await opening;
            Require(session.AdjustmentsReady && !session.HasSidecarLoadError && session.Adjustments.Exposure == 0,
                "missing sidecar did not produce a ready default state");
            Require(handler.Reads == 6 && handler.Writes == 0, "unexpected cloud requests or writes");
        }
        finally
        {
            session.Dispose();
            await session.Renderer.StopAsync();
        }
    }

    private sealed class OpeningResponses : HttpMessageHandler
    {
        private readonly Queue<TaskCompletionSource<HttpResponseMessage>> _responses = new();
        public int Reads { get; private set; }
        public int Writes { get; private set; }
        public TaskCompletionSource<HttpResponseMessage> Next()
        {
            var next = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
            _responses.Enqueue(next);
            return next;
        }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
        {
            if (request.Method != HttpMethod.Get) Writes++;
            if (request.Method != HttpMethod.Get || request.RequestUri?.AbsolutePath != "/api/xmp" || _responses.Count == 0)
                throw new InvalidOperationException("Unexpected request in cloud-opening diagnostic.");
            Reads++;
            return _responses.Dequeue().Task.WaitAsync(cancellation);
        }
    }
}
