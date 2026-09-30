using System.Net;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Transfer;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudTransferTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-cloud-transfer-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(_root)) Directory.Delete(_root, true); }
    private static AdjustmentTransferPatch Patch() => AdjustmentTransfer.Build(new(new AdjustmentState { Exposure = 1 }, 5, null), new[] { "tone" });
    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => respond(request);
    }
    private static HttpResponseMessage Reply(string json, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    [Fact]
    public void WirePatchContainsOnlySelectedTokensAndStandaloneCurves()
    {
        var state = new AdjustmentState { Exposure = 1.25 };
        state.ToneCurveRed.Add(new(.4, .6));
        var patch = XmpTransferPatch.Build(AdjustmentTransfer.Build(new(state, 5, null), new[] { "tone" }));
        Assert.Equal("1.25", patch.Attributes["crs:Exposure2012"]);
        Assert.Null(patch.Attributes["crs:Contrast2012"]);
        Assert.DoesNotContain("crs:Saturation", patch.Attributes.Keys);
        Assert.DoesNotContain("papp:WbSampleX", patch.Attributes.Keys);
        var curve = patch.Elements.Single(e => e.Key.Contains("SceneLinearToneCurveRed"));
        Assert.NotNull(curve.Value);
        Assert.NotNull(XElement.Parse(curve.Value!).Descendants().FirstOrDefault());
    }

    [Fact]
    public async Task LostSubmissionResponseReusesTheDurableIdentityAndPayload()
    {
        var requests = new List<string>();
        using var client = new CloudClient("https://maple.example.test", new Handler(async request =>
        {
            Assert.Equal("/api/jobs", request.RequestUri!.AbsolutePath);
            var body = await request.Content!.ReadAsStringAsync();
            requests.Add(body);
            if (requests.Count == 1) throw new HttpRequestException("Response lost after server accepted the job.");
            using var parsed = JsonDocument.Parse(body);
            Assert.False(parsed.RootElement.GetProperty("payload").TryGetProperty("relativeWhiteBalance", out _));
            return Reply(JsonSerializer.Serialize(new { id = parsed.RootElement.GetProperty("requestId").GetString() }));
        }), Path.Combine(_root, "cache"));
        var job = await CloudTransferJob.PrepareAsync(_root, client, new[] { new CloudTransferTarget("photo", "/photos/a.dng") },
            new Dictionary<string, string> { ["photo"] = "a.dng" }, Patch());
        var id = job.Id;
        await Assert.ThrowsAsync<HttpRequestException>(() => job.SubmitPendingAsync(CancellationToken.None));
        var recovered = await CloudTransferJob.OpenAsync(_root, id, client);
        Assert.True(recovered.SubmissionPending);
        await recovered.SubmitPendingAsync(CancellationToken.None);
        Assert.False(recovered.SubmissionPending);
        Assert.Equal(requests[0], requests[1]);
        Assert.False((await CloudTransferJob.OpenAsync(_root, id, client)).SubmissionPending);
    }

    [Fact]
    public async Task CloudErrorsPreserveNamedFailuresAndDoNotBecomeEmptySuccesses()
    {
        const string id = "1234567890abcdef12345678";
        using var client = new CloudClient("https://maple.example.test", new Handler(request => Task.FromResult(Reply($$$"""
            {"id":"{{{id}}}","status":"done","progress":{"current":2,"total":2},"result":{"applied":["first"],"failed":[{"id":"second","reason":"Permission denied"}],"remaining":[],"cancelled":false}}
            """))), Path.Combine(_root, "cache"));
        var job = await client.GetTransferJobAsync(id, CancellationToken.None);
        Assert.Equal("Permission denied", Assert.Single(job.Result!.Failed).Reason);
        using var offline = new CloudClient("https://maple.example.test", new Handler(_ => Task.FromResult(Reply("{}", HttpStatusCode.ServiceUnavailable))), Path.Combine(_root, "cache2"));
        await Assert.ThrowsAsync<HttpRequestException>(() => offline.GetTransferJobAsync(id, CancellationToken.None));
        await Assert.ThrowsAsync<HttpRequestException>(() => offline.GetTransferBaselineAsync("/photos/a & b.dng", CancellationToken.None));
    }

    [Fact]
    public async Task RelativeSubmissionCarriesCorrectionAndCurrentScale()
    {
        using var client = new CloudClient("https://maple.example.test", new Handler(async request =>
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            var payload = body.RootElement.GetProperty("payload");
            Assert.Equal(500, payload.GetProperty("relativeWhiteBalance").GetProperty("temperature").GetDouble());
            Assert.Equal("5", payload.GetProperty("patch").GetProperty("attributes").GetProperty("papp:WbScaleVersion").GetString());
            return Reply(JsonSerializer.Serialize(new { id = body.RootElement.GetProperty("requestId").GetString() }));
        }), Path.Combine(_root, "cache"));
        var source = new AdjustmentTransferSource(new(), 5, new(6000, 0));
        var patch = AdjustmentTransfer.Build(source, new[] { "white_balance" });
        var job = await CloudTransferJob.PrepareAsync(_root, client, new[] { new CloudTransferTarget("p", "/a.dng") },
            new Dictionary<string, string> { ["p"] = "a.dng" }, patch, new(500, -3));
        await job.SubmitPendingAsync(CancellationToken.None);
    }

    [DemosaicNativeFact]
    public async Task NativeBaselineReadsCameraMetadataWithoutChangingTheOriginal()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var path = Environment.GetEnvironmentVariable("MAPLE_DEMOSAIC_TEST_RAW")!;
        var before = SHA256.HashData(await File.ReadAllBytesAsync(path));
        var baseline = await TransferBaseline.ReadAsync(path, CancellationToken.None);
        Assert.True(baseline.IsValid);
        Assert.Equal(0, baseline.Temperature % 50);
        Assert.Equal(Math.Round(baseline.Tint), baseline.Tint);
        Assert.Equal(before, SHA256.HashData(await File.ReadAllBytesAsync(path)));
    }

    [Fact]
    public async Task RetryRecoveryKeepsOriginalJournalLocationAndReusesNewRequestId()
    {
        string? originalId = null;
        var retryIds = new List<string>();
        using var client = new CloudClient("https://maple.example.test", new Handler(async request =>
        {
            if (request.Method == HttpMethod.Get)
                return Reply(JsonSerializer.Serialize(new { id = originalId, status = "done", progress = new { current = 1, total = 1 },
                    result = new { applied = Array.Empty<string>(), failed = new[] { new { id = "p", reason = "Locked" } }, remaining = Array.Empty<string>(), cancelled = false } }));
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            var id = body.RootElement.GetProperty("requestId").GetString()!;
            if (request.RequestUri!.AbsolutePath == "/api/jobs") originalId = id;
            else
            {
                Assert.Equal($"/api/jobs/{originalId}/retry-failed", request.RequestUri.AbsolutePath);
                retryIds.Add(id);
                if (retryIds.Count == 1) throw new HttpRequestException("Lost retry response");
            }
            return Reply(JsonSerializer.Serialize(new { id }));
        }), Path.Combine(_root, "cache"));
        var job = await CloudTransferJob.PrepareAsync(_root, client, new[] { new CloudTransferTarget("p", "/a.dng") },
            new Dictionary<string, string> { ["p"] = "a.dng" }, Patch());
        var storageId = job.Id;
        await job.SubmitPendingAsync(CancellationToken.None);
        await Assert.ThrowsAsync<HttpRequestException>(() => job.ContinueAsync(true, CancellationToken.None));
        var reopened = await CloudTransferJob.OpenAsync(_root, storageId, client);
        await reopened.SubmitPendingAsync(CancellationToken.None);
        Assert.Equal(2, retryIds.Count);
        Assert.Equal(retryIds[0], retryIds[1]);
        Assert.NotEqual(storageId, reopened.Id);
        Assert.Equal("a.dng", reopened.Names["p"]);
    }

    [Fact]
    public async Task TwoRecoveryWindowsCannotSubmitWhileAnotherOwnsTheJournal()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var posts = 0;
        using var client = new CloudClient("https://maple.example.test", new Handler(async request =>
        {
            Interlocked.Increment(ref posts);
            entered.SetResult();
            await release.Task;
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            return Reply(JsonSerializer.Serialize(new { id = body.RootElement.GetProperty("requestId").GetString() }));
        }), Path.Combine(_root, "cache"));
        var first = await CloudTransferJob.PrepareAsync(_root, client, new[] { new CloudTransferTarget("p", "/a.dng") },
            new Dictionary<string, string> { ["p"] = "a.dng" }, Patch());
        var second = await CloudTransferJob.OpenAsync(_root, first.StorageId, client);
        var submit = first.SubmitPendingAsync(CancellationToken.None);
        await entered.Task;
        try { await Assert.ThrowsAsync<IOException>(() => second.SubmitPendingAsync(CancellationToken.None)); }
        finally { release.SetResult(); }
        await submit;
        await second.SubmitPendingAsync(CancellationToken.None);
        Assert.Equal(1, posts);
        Assert.False(second.SubmissionPending);
    }

    [Fact]
    public async Task LostResumeResponseReconcilesAlreadyRunningJob()
    {
        var id = "";
        var reads = 0;
        using var client = new CloudClient("https://maple.example.test", new Handler(async request =>
        {
            if (request.Method == HttpMethod.Get)
                return Reply(JsonSerializer.Serialize(new { id, status = ++reads == 1 ? "cancelled" : "running", progress = new { current = 1, total = 2 },
                    checkpoint = new { applied = new[] { "a" }, failed = Array.Empty<object>(), remaining = new[] { "p" }, cancelled = true } }));
            if (request.RequestUri!.AbsolutePath.EndsWith("/resume")) return Reply("{}", HttpStatusCode.Conflict);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            id = body.RootElement.GetProperty("requestId").GetString()!;
            return Reply(JsonSerializer.Serialize(new { id }));
        }), Path.Combine(_root, "cache"));
        var job = await CloudTransferJob.PrepareAsync(_root, client, new[] { new CloudTransferTarget("p", "/a.dng") },
            new Dictionary<string, string> { ["p"] = "a.dng" }, Patch());
        await job.SubmitPendingAsync(CancellationToken.None);
        await job.ContinueAsync(false, CancellationToken.None);
        Assert.False(job.SubmissionPending);
        using var otherServer = new CloudClient("https://other.example.test", new Handler(_ => throw new Exception("Must not contact other server")), Path.Combine(_root, "cache2"));
        await Assert.ThrowsAsync<InvalidDataException>(() => CloudTransferJob.OpenAsync(_root, id, otherServer));
    }
}
