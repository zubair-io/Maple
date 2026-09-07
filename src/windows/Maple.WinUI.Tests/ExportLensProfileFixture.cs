using System.Buffers.Binary;
using System.Text;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Export;
using Xunit;

namespace Maple.WinUI.Tests;

/// <summary>Authored 64×64 RAW/LCP pair; no camera corpus or user assets required.</summary>
internal sealed class ExportLensProfileFixture : IDisposable
{
    public string Root { get; } = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "maple-native-lcp-" + Guid.NewGuid().ToString("N")));
    public string RawPath => Path.Combine(Root, "photo.dng");
    public string Ledger => Path.Combine(Root, "ledger");
    public ExportQueueStore Store { get; }
    public ExportQueueRunner Runner { get; }

    public ExportLensProfileFixture()
    {
        Directory.CreateDirectory(Root);
        var repository = new DirectoryInfo(AppContext.BaseDirectory);
        while (repository != null && !File.Exists(Path.Combine(repository.FullName, "CLAUDE.md"))) repository = repository.Parent;
        Assert.NotNull(repository);
        var original = File.ReadAllBytes(Path.Combine(repository.FullName, "src", "apple", "MapleUITests", "Fixtures", "synthetic", "grey-l018-rggb.dng"));
        File.WriteAllBytes(RawPath, AddCaptureMetadata(original));
        Store = new ExportQueueStore(Ledger);
        Runner = new ExportQueueRunner(Store, new NativeExportRecipeExecutor());
    }

    public ExportRecipe Recipe => new()
    {
        SchemaVersion = 1, Name = "Optical native regression", Format = "png", Quality = null, BitDepth = 8,
        MaxLongEdge = null, OutputProfile = "srgb", RenderingIntent = "maple-display", MetadataPolicy = "strip",
        NamingTemplate = "{original}.{ext}", Destination = "directory", Directory = Root, Watermark = null, OverwritePolicy = "error",
    };

    public ExportQueueJob Queue(string stem, AdjustmentState model) => Runner.Create(Recipe,
        new[] { new ExportInput(RawPath, ExportSnapshot.Serialize(null, model), stem, null) }, new[] { RawPath });

    public static byte[] Profile() => Encoding.UTF8.GetBytes($$"""
        <x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
          xmlns:p="http://ns.adobe.com/photoshop/1.0/" xmlns:c="http://ns.adobe.com/photoshop/1.0/camera-profile">
          <!-- Unique authored test bytes: {{Guid.NewGuid():N}} -->
          <r:RDF><r:Description><p:CameraProfiles><r:Seq>
          <r:li c:Make="Maple Test" c:Model="Cold Export Fixture" c:Lens="Prime"
            c:CameraRawProfile="True" c:SensorFormatFactor="1" c:FocalLength="35"
            c:ApertureValue="4" c:FocusDistance="4" c:ImageWidth="64" c:ImageLength="64">
            <c:PerspectiveModel c:Version="2" c:RadialDistortParam1="0">
              <c:VignetteModel c:VignetteModelParam1="-0.4"/>
            </c:PerspectiveModel>
          </r:li></r:Seq></p:CameraProfiles></r:Description></r:RDF></x:xmpmeta>
        """);

    private static byte[] AddCaptureMetadata(byte[] original)
    {
        Assert.Equal("II", Encoding.ASCII.GetString(original, 0, 2));
        Assert.Equal(42, BinaryPrimitives.ReadUInt16LittleEndian(original.AsSpan(2)));
        using var bytes = new MemoryStream();
        bytes.Write(original);
        uint Append(byte[] value)
        {
            if (bytes.Length % 2 != 0) bytes.WriteByte(0);
            var offset = checked((uint)bytes.Length);
            bytes.Write(value);
            return offset;
        }
        byte[] Entry(ushort tag, ushort type, uint count, byte[] value)
        {
            var result = new byte[12];
            BinaryPrimitives.WriteUInt16LittleEndian(result, tag);
            BinaryPrimitives.WriteUInt16LittleEndian(result.AsSpan(2), type);
            BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(4), count);
            if (value.Length <= 4) value.CopyTo(result, 8);
            else BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(8), Append(value));
            return result;
        }
        byte[] Text(ushort tag, string value) => Entry(tag, 2, (uint)value.Length + 1, Encoding.ASCII.GetBytes(value + '\0'));
        byte[] Rational(ushort tag, uint value)
        {
            var payload = new byte[8];
            BinaryPrimitives.WriteUInt32LittleEndian(payload, value);
            BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(4), 1);
            return Entry(tag, 5, 1, payload);
        }
        uint Ifd(IEnumerable<byte[]> entries)
        {
            var sorted = entries.OrderBy(entry => BinaryPrimitives.ReadUInt16LittleEndian(entry)).ToArray();
            var table = new byte[2 + sorted.Length * 12 + 4];
            BinaryPrimitives.WriteUInt16LittleEndian(table, checked((ushort)sorted.Length));
            for (var i = 0; i < sorted.Length; i++) sorted[i].CopyTo(table, 2 + i * 12);
            return Append(table);
        }
        var exif = Ifd(new[] { Rational(33437, 4), Rational(37382, 4), Rational(37386, 35), Text(42036, "Prime") });
        var pointer = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(pointer, exif);
        var rootEntries = new List<byte[]> { Text(271, "Maple Test"), Text(272, "Cold Export Fixture"), Text(50708, "Cold Export Fixture"), Entry(34665, 4, 1, pointer) };
        var replaced = rootEntries.Select(entry => BinaryPrimitives.ReadUInt16LittleEndian(entry)).ToHashSet();
        var oldRoot = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(original.AsSpan(4)));
        var count = BinaryPrimitives.ReadUInt16LittleEndian(original.AsSpan(oldRoot));
        for (var i = 0; i < count; i++)
        {
            var entry = original.AsSpan(oldRoot + 2 + i * 12, 12);
            if (!replaced.Contains(BinaryPrimitives.ReadUInt16LittleEndian(entry))) rootEntries.Add(entry.ToArray());
        }
        var root = Ifd(rootEntries);
        var result = bytes.ToArray();
        BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(4), root);
        return result;
    }

    public void Dispose()
    {
        Assert.Equal(Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar), Path.GetDirectoryName(Root));
        Assert.StartsWith("maple-native-lcp-", Path.GetFileName(Root));
        Directory.Delete(Root, recursive: true);
    }
}
