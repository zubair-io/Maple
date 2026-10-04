using Maple.WinUI.Services.Metadata;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class MetadataKeywordSummaryTests
{
    public static IEnumerable<object[]> KeywordSets()
    {
        yield return new object[] { new[] { "Alpha, Beta" }, new[] { "Alpha", "Beta" }, "Mixed" };
        yield return new object[] { Array.Empty<string>(), new[] { "none" }, "Mixed" };
        yield return new object[] { new[] { "Beta", "Alpha" }, new[] { "Alpha", "Beta" }, "Alpha, Beta" };
        yield return new object[] { new[] { "Alpha" }, new[] { "alpha" }, "Mixed" };
        yield return new object[] { Array.Empty<string>(), Array.Empty<string>(), "none" };
    }

    [Theory]
    [MemberData(nameof(KeywordSets))]
    public void CurrentSummaryDistinguishesPersistedKeywordSets(string[] first, string[] second, string expected)
    {
        var paths = new[] { first, second }.Select(_ =>
            Path.Combine(Path.GetTempPath(), "maple-keyword-summary-" + Guid.NewGuid().ToString("N") + ".dng")).ToArray();
        try
        {
            for (var i = 0; i < paths.Length; i++)
            {
                var document = new XmpSidecarDocument();
                new MetadataPatch(KeywordOperation: KeywordOperation.Replace, Keywords: i == 0 ? first : second).Apply(document);
                SidecarStore.Save(paths[i], document);
            }
            var values = paths.Select(path => MetadataValues.Read(SidecarStore.Load(path)!)).ToArray();
            Assert.Equal(first, values[0].Keywords);
            Assert.Equal(second, values[1].Keywords);
            var before = paths.Select(path => File.ReadAllBytes(SidecarStore.SidecarPathFor(path))).ToArray();
            Assert.Equal(expected, MetadataValues.KeywordSummary(values));
            for (var i = 0; i < paths.Length; i++)
                Assert.Equal(before[i], File.ReadAllBytes(SidecarStore.SidecarPathFor(paths[i])));
        }
        finally
        {
            foreach (var path in paths) File.Delete(SidecarStore.SidecarPathFor(path));
        }
    }
}
