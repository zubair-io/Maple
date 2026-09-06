using System.Net;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Export;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class ExportSnapshotTests
{
    [Theory]
    [InlineData(401)]
    [InlineData(403)]
    [InlineData(500)]
    [InlineData(503)]
    public async Task Cloud_export_does_not_turn_http_failure_into_default_edits(int status)
    {
        using var response = new HttpResponseMessage((HttpStatusCode)status);
        await Assert.ThrowsAsync<HttpRequestException>(() => ExportSnapshot.ReadSidecarResponseAsync(response, CancellationToken.None));
    }

    [Fact]
    public async Task Only_missing_sidecar_means_default_edits()
    {
        using var absent = new HttpResponseMessage(HttpStatusCode.NotFound);
        Assert.Null(await ExportSnapshot.ReadSidecarResponseAsync(absent, CancellationToken.None));
        using var present = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("<broken") };
        var xml = await ExportSnapshot.ReadSidecarResponseAsync(present, CancellationToken.None);
        Assert.Throws<InvalidDataException>(() => ExportSnapshot.Serialize(xml));
    }

    [Fact]
    public void Active_snapshot_keeps_unsaved_edits_and_passthrough_without_mutating_source()
    {
        var source = new XmpSidecarDocument();
        source.PassthroughNamespaces.Add(new("custom", "urn:export-test"));
        source.PassthroughAttributes.Add(new("custom:delivery", "retain"));
        source.Adjustments.Exposure = 0.25f;
        var xml = XmpWriter.Serialize(source);
        var active = source.Adjustments.Clone();
        active.Exposure = 1.75f;
        var frozen = ExportSnapshot.Serialize(xml, active);
        active.Exposure = -1;
        var reopened = XmpParser.Parse(frozen)!;
        Assert.Equal(1.75f, reopened.Adjustments.Exposure);
        Assert.Contains(reopened.PassthroughAttributes, a => a.Name == "custom:delivery" && a.Value == "retain");
        Assert.Equal(0.25f, XmpParser.Parse(xml)!.Adjustments.Exposure);
    }
}
