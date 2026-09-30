using System.Text;
using Maple.WinUI.Services.Transfer;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class TransferSnapshotTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-transfer-snapshot-" + Guid.NewGuid().ToString("N"));
    public TransferSnapshotTests() => Directory.CreateDirectory(_root);
    public void Dispose() => Directory.Delete(_root, true);

    [Fact]
    public async Task PreviewRetainsExactRevisionAndUnderstandsBom()
    {
        var path = Path.Combine(_root, "photo.dng");
        var sidecar = SidecarStore.SidecarPathFor(path);
        var doc = new XmpSidecarDocument { Rating = 4 };
        doc.Adjustments.Exposure = 1.5;
        await File.WriteAllTextAsync(sidecar, XmpWriter.Serialize(doc), new UTF8Encoding(true));
        var bytes = await File.ReadAllBytesAsync(sidecar);
        var snapshot = await TransferSnapshot.ReadAsync(path, null, CancellationToken.None);
        Assert.Equal(SidecarStore.SnapshotHash(bytes), snapshot.ExpectedHash);
        Assert.Equal(1.5, snapshot.Document.Adjustments.Exposure);
        Assert.Equal(4, snapshot.Document.Rating);
        await File.AppendAllTextAsync(sidecar, "\n");
        Assert.NotEqual(SidecarStore.SnapshotHash(await File.ReadAllBytesAsync(sidecar)), snapshot.ExpectedHash);
    }

    [Fact]
    public async Task OnlyAbsentSidecarsUseDefaults()
    {
        var path = Path.Combine(_root, "photo.dng");
        var missing = await TransferSnapshot.ReadAsync(path, null, CancellationToken.None);
        Assert.Equal("absent", missing.ExpectedHash);
        await File.WriteAllTextAsync(SidecarStore.SidecarPathFor(path), "<invalid>");
        await Assert.ThrowsAsync<InvalidDataException>(() => TransferSnapshot.ReadAsync(path, null, CancellationToken.None));
        await File.WriteAllBytesAsync(SidecarStore.SidecarPathFor(path), new byte[] { 0xff, 0xfe, 0xff });
        await Assert.ThrowsAnyAsync<Exception>(() => TransferSnapshot.ReadAsync(path, null, CancellationToken.None));
    }
}
