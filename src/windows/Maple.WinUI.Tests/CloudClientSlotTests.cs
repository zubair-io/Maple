using System.Net;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudClientSlotTests : IDisposable
{
    private readonly string _cache = Path.Combine(Path.GetTempPath(), "maple-cloud-slot-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(_cache)) Directory.Delete(_cache, true); }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<HttpMethod> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request.Method);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(XmpWriter.Serialize(new XmpSidecarDocument())),
            });
        }
    }

    [Fact]
    public async Task ServerBNeverReceivesTheModelOpenedAgainstServerA()
    {
        var handlerA = new RecordingHandler();
        var handlerB = new RecordingHandler();
        using var clientA = new CloudClient("https://a.example.test", handlerA, _cache);
        using var clientB = new CloudClient("https://b.example.test", handlerB, _cache);
        var slot = new CloudClientSlot();

        slot.Adopt(clientA);
        var stampedWhenPhotoOpened = slot.Generation;
        Assert.Same(clientA, slot.Resolve(stampedWhenPhotoOpened));

        slot.Adopt(clientB);

        Assert.Null(slot.Resolve(stampedWhenPhotoOpened));
        await (slot.Resolve(stampedWhenPhotoOpened)?.UpdateDevelopSidecarAsync(
            "/shared/path.dng", new AdjustmentState { Exposure = 2 }) ?? Task.CompletedTask);
        Assert.Empty(handlerB.Requests);
        await slot.Resolve(slot.Generation)!.UpdateDevelopSidecarAsync("/shared/path.dng", new AdjustmentState());
        Assert.NotEmpty(handlerB.Requests);
        Assert.Same(clientB, slot.Resolve(slot.Generation));
    }

    [Fact]
    public void AdoptingTheSameClientKeepsTheGeneration()
    {
        using var client = new CloudClient("https://a.example.test", new RecordingHandler(), _cache);
        var slot = new CloudClientSlot();
        slot.Adopt(client);
        var generation = slot.Generation;
        slot.Adopt(client);
        Assert.Equal(generation, slot.Generation);
    }
}
