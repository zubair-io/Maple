// SidecarClaimFormatTests — which sibling files claim a sidecar stem (#4758).
// The format list is not a Windows opinion: every extension the API indexes
// (SUPPORTED_EXTS) or Apple treats as a RAW / non-RAW image shares
// `<stem>.xmp` on that surface, so Windows must treat each one as a claimant.

using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class SidecarClaimFormatTests : IDisposable
    {
        private readonly string _dir;

        public SidecarClaimFormatTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-claim-format-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string P(params string[] parts) => Path.Combine(_dir, Path.Combine(parts));

        private string Write(string content, params string[] parts)
        {
            var full = P(parts);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        private static string? RepoFile(string relative)
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            {
                var candidate = Path.Combine(dir.FullName, relative);
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }

        private static string[] ApiSupportedExtensions()
        {
            var path = RepoFile("src/api/src/workers/discover/types.ts");
            if (path == null) return Array.Empty<string>();
            var body = File.ReadAllText(path);
            var start = body.IndexOf("SUPPORTED_EXTS = new Set([", StringComparison.Ordinal);
            var block = body[start..body.IndexOf("])", start, StringComparison.Ordinal)];
            return Regex.Matches(block, @"'(\.[a-z0-9]+)'").Select(m => m.Groups[1].Value).ToArray();
        }

        private static string[] AppleImageExtensions()
        {
            var path = RepoFile("src/apple/Packages/MapleCore/Sources/MapleCore/Sources/FilesystemSource.swift");
            if (path == null) return Array.Empty<string>();
            var body = File.ReadAllText(path);
            return new[] { "enum RAWExtensions", "enum NonRawImageExtensions" }
                .Select(marker => body.IndexOf(marker, StringComparison.Ordinal))
                .SelectMany(start =>
                {
                    var set = body.IndexOf("Set<String> = [", start, StringComparison.Ordinal);
                    var block = body[set..body.IndexOf(']', set)];
                    return Regex.Matches(block, "\"([a-z0-9]+)\"").Select(m => "." + m.Groups[1].Value);
                })
                .ToArray();
        }

        [Fact]
        public void EveryExtensionTheApiIndexesClaimsAStem()
        {
            var extensions = ApiSupportedExtensions();
            if (extensions.Length == 0) return;
            var missing = extensions.Where(e => !LocalFileOperations.IsMediaFile("IMG_1" + e)).ToArray();
            Assert.Empty(missing);
        }

        [Fact]
        public void EveryExtensionAppleTreatsAsAnImageClaimsAStem()
        {
            var extensions = AppleImageExtensions();
            if (extensions.Length == 0) return;
            var missing = extensions.Where(e => !LocalFileOperations.IsMediaFile("IMG_1" + e)).ToArray();
            Assert.Empty(missing);
        }

        [Fact]
        public async Task Move_WithAMefSiblingStillReadingTheSidecar_KeepsItInPlace()
        {
            var raw = Write("raw", "src", "IMG_1.CR3");
            Write("mef", "src", "IMG_1.MEF");
            Write("<shared/>", "src", "IMG_1.xmp");

            await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.Equal("<shared/>", File.ReadAllText(P("src", "IMG_1.xmp")));
            Assert.Equal("<shared/>", File.ReadAllText(P("album", "IMG_1.xmp")));
        }

        [Fact]
        public void SiblingsWithDistinctUnicodeFormsClaimOnlyWhereTheFolderTreatsThemAsOneName()
        {
            var composed = "é";
            var decomposed = "é";
            var raw = Write("raw", "photos", composed + ".CR3");
            Write("jpg", "photos", decomposed + ".JPG");
            var foldsForms = File.Exists(P("photos", composed + ".JPG"));

            Assert.Equal(foldsForms, LocalFileOperations.SidecarStemClaimedBySibling(raw));
        }
    }
}
