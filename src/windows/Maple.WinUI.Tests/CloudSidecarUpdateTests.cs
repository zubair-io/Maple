using System.Net;
using System.Text.Json;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudSidecarUpdateTests : IDisposable
{
    private readonly string _cache = Path.Combine(Path.GetTempPath(), "maple-cloud-sidecar-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(_cache)) Directory.Delete(_cache, true); }

    [Fact]
    public async Task DevelopReadsLatestMetadataAndFreezesAdjustmentsBeforeAwait()
    {
        var doc = new XmpSidecarDocument { Rating = 4, ColorLabel = "purple" };
        MetadataValues.SetKeywords(doc, new[] { "new keyword", "東京" });
        doc.PassthroughAttributes.Add(new("custom", "retained"));
        using var handler = new SidecarHandler(XmpWriter.Serialize(doc)) { PauseFirstRead = true };
        using var client = new CloudClient("https://maple.example.test", handler, _cache);
        var model = new AdjustmentState { Exposure = 0.75 };
        var write = client.UpdateDevelopSidecarAsync("/a.dng", model);
        await handler.ReadStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        model.Exposure = 3;
        handler.ReleaseRead.SetResult();
        await write;
        var saved = XmpParser.Parse(handler.Xml)!;
        Assert.Equal(0.75, saved.Adjustments.Exposure);
        Assert.Equal(4, saved.Rating);
        Assert.Equal("purple", saved.ColorLabel);
        Assert.Equal(new[] { "new keyword", "東京" }, MetadataValues.Read(saved).Keywords);
        Assert.Contains(saved.PassthroughAttributes, a => a.Name == "custom" && a.Value == "retained");
    }

    [Fact]
    public async Task LaterDevelopCannotOvertakeInFlightReadModifyWrite()
    {
        using var handler = new SidecarHandler(XmpWriter.Serialize(new())) { PauseFirstRead = true };
        using var client = new CloudClient("https://maple.example.test", handler, _cache);
        var first = client.UpdateDevelopSidecarAsync("/a.dng", new() { Exposure = 1 });
        await handler.ReadStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = client.UpdateDevelopSidecarAsync("/a.dng", new() { Exposure = 2 });
        Assert.Equal(1, handler.Reads);
        handler.ReleaseRead.SetResult();
        await Task.WhenAll(first, second);
        Assert.Equal(new[] { 1d, 2d }, handler.WrittenExposure);
        Assert.Equal(2, XmpParser.Parse(handler.Xml)!.Adjustments.Exposure);
    }

    [Theory]
    [InlineData("<broken", HttpStatusCode.OK)]
    [InlineData("", HttpStatusCode.Forbidden)]
    public async Task UnreadableExistingSidecarIsNeverOverwritten(string xml, HttpStatusCode status)
    {
        using var handler = new SidecarHandler(xml) { ReadStatus = status };
        using var client = new CloudClient("https://maple.example.test", handler, _cache);
        await Assert.ThrowsAnyAsync<Exception>(() => client.UpdateDevelopSidecarAsync("/a.dng", new()));
        Assert.Empty(handler.WrittenExposure);
        // A failed read releases the serialization gate for a later retry.
        handler.Xml = XmpWriter.Serialize(new());
        handler.ReadStatus = HttpStatusCode.OK;
        await client.UpdateDevelopSidecarAsync("/a.dng", new() { Exposure = 0.5 });
        Assert.Single(handler.WrittenExposure);
    }

    [Fact]
    public async Task MetadataBetweenDevelopSavesSurvivesTheNextAutosave()
    {
        using var handler = new SidecarHandler(XmpWriter.Serialize(new())) { PauseFirstRead = true };
        using var client = new CloudClient("https://maple.example.test", handler, _cache);
        var develop = client.UpdateDevelopSidecarAsync("/a.dng", new() { Exposure = 1 });
        await handler.ReadStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var metadata = client.ApplyMetadataAsync("/a.dng", "photos:a.dng",
            new(Rating: 5, KeywordOperation: KeywordOperation.Add, Keywords: new[] { "keep me" }), CancellationToken.None);
        handler.ReleaseRead.SetResult();
        await Task.WhenAll(develop, metadata);
        await client.UpdateDevelopSidecarAsync("/a.dng", new() { Exposure = 2 });
        var saved = XmpParser.Parse(handler.Xml)!;
        Assert.Equal(2, saved.Adjustments.Exposure);
        Assert.Equal(5, saved.Rating);
        Assert.Equal(new[] { "keep me" }, MetadataValues.Read(saved).Keywords);
    }

    [Fact]
    public async Task RatingPatchDoesNotSendUnrelatedCullingFields()
    {
        var doc = new XmpSidecarDocument { Rating = 2, Flag = "reject", ColorLabel = "purple" };
        using var handler = new SidecarHandler(XmpWriter.Serialize(doc));
        using var client = new CloudClient("https://maple.example.test", handler, _cache);
        var saved = await client.ApplyMetadataAsync("/a.dng", "photos:a.dng",
            new(Rating: 5), CancellationToken.None);
        using var request = JsonDocument.Parse(handler.LastBatchBody!);
        var fields = request.RootElement.GetProperty("entries")[0].GetProperty("metadata");
        Assert.Equal(new[] { "rating" }, fields.EnumerateObject().Select(p => p.Name).ToArray());
        Assert.Equal(5, saved.Rating);
        Assert.Equal("reject", saved.Flag);
        Assert.Equal("purple", saved.Label);
    }

    private sealed class SidecarHandler(string xml) : HttpMessageHandler
    {
        public string Xml = xml;
        public bool PauseFirstRead;
        public HttpStatusCode ReadStatus = HttpStatusCode.OK;
        public int Reads;
        public string? LastBatchBody;
        public List<double> WrittenExposure { get; } = new();
        public TaskCompletionSource ReadStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource ReleaseRead { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Get)
            {
                Reads++;
                if (Reads == 1 && PauseFirstRead)
                {
                    ReadStarted.SetResult();
                    await ReleaseRead.Task.WaitAsync(cancellationToken);
                }
                return new(ReadStatus) { Content = new StringContent(Xml) };
            }
            var body = await request.Content!.ReadAsStringAsync(cancellationToken);
            if (request.RequestUri!.AbsolutePath.EndsWith("/batch"))
            {
                LastBatchBody = body;
                using var json = JsonDocument.Parse(body);
                var entry = json.RootElement.GetProperty("entries")[0];
                var metadata = entry.GetProperty("metadata");
                var doc = XmpParser.Parse(Xml)!;
                if (metadata.TryGetProperty("rating", out var rating)) doc.Rating = rating.GetInt32();
                if (metadata.TryGetProperty("keywords", out var keywords))
                    MetadataValues.SetKeywords(doc, keywords.EnumerateArray().Select(k => k.GetString()!).ToArray());
                Xml = XmpWriter.Serialize(doc);
                return new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(
                    new { results = new[] { new { address = entry.GetProperty("address").GetString(), ok = true } } })) };
            }
            Xml = body;
            WrittenExposure.Add(XmpParser.Parse(Xml)!.Adjustments.Exposure);
            return new(HttpStatusCode.OK) { Content = new StringContent("{}") };
        }
    }
}
