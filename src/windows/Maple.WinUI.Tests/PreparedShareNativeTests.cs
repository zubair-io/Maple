using System.Runtime.CompilerServices;
using Maple.WinUI.Generated;
using Maple.WinUI.Services.Export;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public sealed class PreparedShareNativeTests(ITestOutputHelper output)
{
    private bool Available()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: native edited sharing requires MAPLE_RAW_FFI_DLL.");
            return false;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        return true;
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Cancel_or_failure_after_first_render_removes_only_owned_share_outputs(bool cancel)
    {
        if (!Available()) return;
        var root = Path.Combine(Path.GetTempPath(), "maple-share-native-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var source = ExportRasterNativeTests.WriteTiff(root);
            var hash = ExportPaths.Hash(source);
            var other = Path.Combine(root, "keep.txt");
            File.WriteAllText(other, "unrelated file");
            using var cancellation = new CancellationTokenSource();
            string owned;
            using (var share = new PreparedShareFiles(root))
            {
                owned = share.DirectoryPath;
                IExportRecipeExecutor executor = cancel ? new CancelAfterRender(cancellation) : new NativeExportRecipeExecutor();
                var task = share.RenderEditedAsync([
                    new(source, ExportRasterNativeTests.Snapshot(1), "first", null),
                    new(source, ExportRasterNativeTests.Snapshot(0, 20), "unsupported", null),
                ], ExportRasterNativeTests.Recipe(root), executor, cancellation.Token);
                if (cancel) await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task);
                else Assert.Contains("AgX contrast", (await Assert.ThrowsAnyAsync<Exception>(() => task)).Message);
                Assert.Single(Directory.GetFiles(owned)); // A real render completed before cancellation/failure.
            }
            Assert.False(Directory.Exists(owned));
            Assert.Equal("unrelated file", File.ReadAllText(other));
            Assert.Equal(hash, ExportPaths.Hash(source));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task Successful_edited_share_retains_readable_jpegs_for_receiver()
    {
        if (!Available()) return;
        var root = Path.Combine(Path.GetTempPath(), "maple-share-retained-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var source = ExportRasterNativeTests.WriteTiff(root);
            var hash = ExportPaths.Hash(source);
            IReadOnlyList<string> paths;
            using (var share = new PreparedShareFiles(root))
            {
                paths = await share.RenderEditedAsync([
                    new(source, ExportRasterNativeTests.Snapshot(), "baseline", null),
                    new(source, ExportRasterNativeTests.Snapshot(1), "edited", null),
                ], ExportRasterNativeTests.Recipe(root), new NativeExportRecipeExecutor(), CancellationToken.None);
                share.RetainForReceiver();
            }
            Assert.Equal(2, paths.Count);
            Assert.NotEqual(ExportPaths.Hash(paths[0]), ExportPaths.Hash(paths[1]));
            Assert.All(paths, path => Assert.Equal(new byte[] { 0xff, 0xd8, 0xff }, File.ReadAllBytes(path)[..3]));
            Assert.Equal(hash, ExportPaths.Hash(source));
        }
        finally { Directory.Delete(root, true); }
    }

    private sealed class CancelAfterRender(CancellationTokenSource cancellation) : IExportRecipeExecutor
    {
        private readonly NativeExportRecipeExecutor _native = new();
        public void Validate(ExportRecipe recipe) => _native.Validate(recipe);
        public string Filename(ExportRecipe recipe, ExportInput input, ulong index) => _native.Filename(recipe, input, index);
        public void Render(ExportRecipe recipe, ExportQueueItem item)
        {
            _native.Render(recipe, item);
            cancellation.Cancel();
        }
    }
}
