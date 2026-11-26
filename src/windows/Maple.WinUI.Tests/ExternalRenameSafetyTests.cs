// ExternalRenameSafetyTests — the sidecar of an external rename is never
// deleted unless every new sidecar is a separate file holding its exact
// bytes (#6072). Real temp files.

using System;
using System.IO;
using System.Linq;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class ExternalRenameSafetyTests : IDisposable
    {
        private readonly string _dir;

        public ExternalRenameSafetyTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-external-safety-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string P(string name) => Path.Combine(_dir, name);

        private void Write(string name, string content) => File.WriteAllText(P(name), content);

        private static string[] Names(string dir) =>
            Directory.EnumerateFileSystemEntries(dir).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToArray()!;

        [Fact]
        public void RenameToAnotherUnicodeFormOfTheSameName_KeepsTheSidecar()
        {
            var composed = "café";
            var decomposed = "café";
            Write(composed + ".jpg", "jpg");
            Write(composed + ".xmp", "<edits/>");
            File.Move(P(composed + ".jpg"), P(decomposed + ".jpg"));

            LocalFileOperations.FollowExternalRenames(new[] { (P(composed + ".jpg"), P(decomposed + ".jpg")) });

            var sidecars = Directory.EnumerateFiles(_dir, "*.xmp").ToList();
            Assert.Single(sidecars);
            Assert.Equal("<edits/>", File.ReadAllText(sidecars[0]));
        }

        [Fact]
        public void SidecarTooLargeToVerify_IsKeptWhenHalvesGoToDifferentStems()
        {
            var bytes = Enumerable.Repeat((byte)'x', (int)SidecarStore.MaxSidecarBytes + 1).ToArray();
            Write("IMG.CR3", "raw");
            Write("IMG.jpg", "jpg");
            File.WriteAllBytes(P("IMG.xmp"), bytes);
            File.Move(P("IMG.CR3"), P("Alpha.CR3"));
            File.Move(P("IMG.jpg"), P("Beta.jpg"));

            LocalFileOperations.FollowExternalRenames(new[]
            {
                (P("IMG.CR3"), P("Alpha.CR3")), (P("IMG.jpg"), P("Beta.jpg")),
            });

            Assert.Equal(bytes, File.ReadAllBytes(P("IMG.xmp")));
            Assert.Equal(bytes.Length, new FileInfo(P("Alpha.xmp")).Length);
            Assert.Equal(bytes.Length, new FileInfo(P("Beta.xmp")).Length);
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void CopyThatCannotBeStaged_KeepsTheOldSidecar_AndCarriesTheOther(bool longFirst)
        {
            var longStem = new string('x', 240);
            Write("IMG.CR3", "raw");
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");
            var (first, second) = longFirst ? (longStem + ".CR3", "Short.jpg") : ("Short.CR3", longStem + ".jpg");
            File.Move(P("IMG.CR3"), P(first));
            File.Move(P("IMG.jpg"), P(second));

            var results = LocalFileOperations.FollowExternalRenames(new[]
            {
                (P("IMG.CR3"), P(first)), (P("IMG.jpg"), P(second)),
            });

            Assert.Equal("<edits/>", File.ReadAllText(P("IMG.xmp")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Short.xmp")));
            Assert.False(File.Exists(P(longStem + ".xmp")));
            var short_ = results.Single(r => Path.GetFileName(r.NewPath).StartsWith("Short"));
            var long_ = results.Single(r => !Path.GetFileName(r.NewPath).StartsWith("Short"));
            Assert.Equal(ExternalRenameSidecarOutcome.Carried, short_.Outcome);
            Assert.Equal(ExternalRenameSidecarOutcome.Failed, long_.Outcome);
            Assert.DoesNotContain(Names(_dir), n => n.Contains(".tmp."));
        }
    }
}
