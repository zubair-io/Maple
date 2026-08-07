// BatchRenameLogicTests — the batch-rename dialog's pure preview logic
// (BuildPreview: self-collision detection, MAX_PATH detection, render-error
// passthrough) plus ApplySequentialAsync's real-filesystem orchestration
// (real temp dirs, per CLAUDE.md's "No mocks" rule — same convention as
// RelocateCollisionTests). The render step is a small FAKE substitution
// function, not the real raw-core engine: this suite is testing
// BatchRenameLogic's OWN sequencing/duplicate-detection/MAX_PATH/
// partial-failure logic, not `{original}`/`{n}`/`{date:FORMAT}` token
// semantics, which are raw-core's own Rust test suite's job (issue #2628)
// and out of reach here anyway — Native/RawFfi.cs (unsafe P/Invoke) is
// deliberately not linked into this project. See BatchRenameTypes.cs's
// header comment.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class BatchRenameLogicTests
    {
        /// <summary>A minimal stand-in for the real raw-core engine:
        /// literal `{original}`/`{n}`/`{ext}` substitution, zero-padding via
        /// <paramref name="sequencePadWidth"/>, a magic `{fail}` template
        /// token that always rejects (simulates a malformed template — the
        /// real engine parses the template once per item, so this fails
        /// EVERY item identically), and a magic `bad` stem that always
        /// rejects on its own (simulates a per-item rejection, like the real
        /// engine's reserved-device-name check, so ApplySequentialAsync's
        /// partial-failure contract is exercisable). Enough surface to test
        /// BatchRenameLogic's own logic without reimplementing the real
        /// token parser.</summary>
        private static FilenameRenderOutcome FakeRender(
            string template, string stem, string ext, string? capturedAt,
            ulong sequenceStart, ulong sequenceIndex, int sequencePadWidth)
        {
            if (template.Contains("{fail}"))
                return FilenameRenderOutcome.Failure(2, "unknown template token {fail}");
            if (stem == "bad")
                return FilenameRenderOutcome.Failure(7, "simulated per-item rejection");

            var n = sequenceStart + sequenceIndex;
            var nText = sequencePadWidth > 0
                ? n.ToString().PadLeft(sequencePadWidth, '0')
                : n.ToString();
            var name = template
                .Replace("{original}", stem)
                .Replace("{n}", nText)
                .Replace("{ext}", ext);
            return FilenameRenderOutcome.Success(name);
        }

        private static BatchRenameSourceItem Item(string key, string dir, string fileName, string? capturedAt = null)
        {
            var ext = Path.GetExtension(fileName).TrimStart('.');
            var stem = Path.GetFileNameWithoutExtension(fileName);
            return new BatchRenameSourceItem(key, dir, fileName, Path.Combine(dir, fileName), stem, ext, capturedAt);
        }

        // --- BuildPreview ---

        [Fact]
        public void BuildPreview_DistinctNames_NoDuplicatesNoErrors()
        {
            var items = new[]
            {
                Item("a", @"C:\lib", "img_1.cr3"),
                Item("b", @"C:\lib", "img_2.cr3"),
            };

            var rows = BatchRenameLogic.BuildPreview(items, "{original}_edit.{ext}", 1, 0, FakeRender);

            Assert.Equal("img_1_edit.cr3", rows[0].NewFileName);
            Assert.Equal("img_2_edit.cr3", rows[1].NewFileName);
            Assert.All(rows, r => Assert.False(r.IsDuplicateWithinBatch));
            Assert.All(rows, r => Assert.True(r.WouldApply));
        }

        [Fact]
        public void BuildPreview_SelfCollidingTemplate_FlagsSecondOccurrenceAsDuplicate()
        {
            // A template with no distinguishing token (design doc's exact
            // "shared-destination template can collide with itself"
            // scenario) renders the same name for every file.
            var items = new[]
            {
                Item("a", @"C:\lib", "img_1.cr3"),
                Item("b", @"C:\lib", "img_2.cr3"),
            };

            var rows = BatchRenameLogic.BuildPreview(items, "vacation.{ext}", 0, 0, FakeRender);

            Assert.False(rows[0].IsDuplicateWithinBatch);
            Assert.Null(rows[0].Error);
            Assert.True(rows[1].IsDuplicateWithinBatch);
            Assert.NotNull(rows[1].Error);
        }

        [Fact]
        public void BuildPreview_SameNameDifferentDirectories_NotFlaggedAsDuplicate()
        {
            var items = new[]
            {
                Item("a", @"C:\lib\a", "img.cr3"),
                Item("b", @"C:\lib\b", "img.cr3"),
            };

            var rows = BatchRenameLogic.BuildPreview(items, "same.{ext}", 0, 0, FakeRender);

            Assert.All(rows, r => Assert.False(r.IsDuplicateWithinBatch));
        }

        [Fact]
        public void BuildPreview_RenderedNameExceedsMaxPath_FlagsErrorAndKeepsRenderedName()
        {
            var longStem = new string('a', 260);
            var items = new[] { Item("a", @"C:\lib", longStem + ".cr3") };

            var rows = BatchRenameLogic.BuildPreview(items, "{original}.{ext}", 0, 0, FakeRender);

            Assert.NotNull(rows[0].NewFileName); // still shown, just marked invalid
            Assert.Contains("MAX_PATH", rows[0].Error);
            Assert.False(rows[0].WouldApply);
        }

        [Fact]
        public void BuildPreview_TemplateRenderError_PassesThroughEngineErrorAndClearsNewName()
        {
            var items = new[] { Item("a", @"C:\lib", "img.cr3") };

            var rows = BatchRenameLogic.BuildPreview(items, "{fail}", 0, 0, FakeRender);

            Assert.Null(rows[0].NewFileName);
            Assert.Equal("unknown template token {fail}", rows[0].Error);
            Assert.False(rows[0].WouldApply);
        }

        [Fact]
        public void BuildPreview_ExtensionChanged_IsFlaggedPerRow()
        {
            var items = new[] { Item("a", @"C:\lib", "img.cr3") };

            var unchanged = BatchRenameLogic.BuildPreview(items, "{original}.{ext}", 0, 0, FakeRender);
            var changed = BatchRenameLogic.BuildPreview(items, "{original}.jpg", 0, 0, FakeRender);

            Assert.False(unchanged[0].ExtensionChanged);
            Assert.True(changed[0].ExtensionChanged);
        }

        [Fact]
        public void BuildPreview_SequenceIndexMatchesItemPosition()
        {
            var items = new[]
            {
                Item("a", @"C:\lib", "a.cr3"),
                Item("b", @"C:\lib", "b.cr3"),
                Item("c", @"C:\lib", "c.cr3"),
            };

            var rows = BatchRenameLogic.BuildPreview(items, "shot_{n}.{ext}", 1, 3, FakeRender);

            Assert.Equal("shot_001.cr3", rows[0].NewFileName);
            Assert.Equal("shot_002.cr3", rows[1].NewFileName);
            Assert.Equal("shot_003.cr3", rows[2].NewFileName);
        }

    }

    // --- ApplySequentialAsync (real temp directory, real LocalFileOperations) ---
    //
    // A separate top-level class (not nested inside BatchRenameLogicTests)
    // so its IDisposable per-test temp-directory fixture is unambiguously
    // picked up by xUnit's constructor/Dispose-per-test convention — the
    // same shape RelocateCollisionTests already uses.
    public class BatchRenameLogicApplySequentialAsyncTests : IDisposable
    {
        private readonly string _dir;

        public BatchRenameLogicApplySequentialAsyncTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-batchrename-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        /// <summary>Same FakeRender contract as BatchRenameLogicTests's
        /// (magic `{fail}` template token, magic `bad` stem) — duplicated
        /// rather than shared across classes to keep each test class
        /// self-contained, matching this project's existing style (e.g.
        /// RelocateCollisionTests's own private WriteFile helper).</summary>
        private static FilenameRenderOutcome FakeRender(
            string template, string stem, string ext, string? capturedAt,
            ulong sequenceStart, ulong sequenceIndex, int sequencePadWidth)
        {
            if (template.Contains("{fail}"))
                return FilenameRenderOutcome.Failure(2, "unknown template token {fail}");
            if (stem == "bad")
                return FilenameRenderOutcome.Failure(7, "simulated per-item rejection");

            var n = sequenceStart + sequenceIndex;
            var nText = sequencePadWidth > 0
                ? n.ToString().PadLeft(sequencePadWidth, '0')
                : n.ToString();
            return FilenameRenderOutcome.Success(
                template.Replace("{original}", stem).Replace("{n}", nText).Replace("{ext}", ext));
        }

        private BatchRenameSourceItem WriteItem(string key, string fileName, string content)
        {
            var full = Path.Combine(_dir, fileName);
            File.WriteAllText(full, content);
            var ext = Path.GetExtension(fileName).TrimStart('.');
            var stem = Path.GetFileNameWithoutExtension(fileName);
            return new BatchRenameSourceItem(key, _dir, fileName, full, stem, ext, null);
        }

        [Fact]
        public async Task SelfCollidingTemplate_SecondItemAutoSuffixesAgainstTheFirstsRealResult()
        {
            // The design doc's core batch-rename requirement: applied
            // SEQUENTIALLY so the second item's collision check sees the
            // FIRST item's already-renamed file on disk, not just
            // pre-existing files.
            var a = WriteItem("a", "shot_a.dng", "A");
            var b = WriteItem("b", "shot_b.dng", "B");

            var outcomes = await BatchRenameLogic.ApplySequentialAsync(
                new[] { a, b }, "vacation.{ext}", 0, 0, CollisionPolicy.AutoSuffix, FakeRender);

            Assert.Equal(BatchRenameOutcomeKind.Relocated, outcomes[0].Kind);
            Assert.Equal(BatchRenameOutcomeKind.Relocated, outcomes[1].Kind);
            Assert.Equal("vacation.dng", outcomes[0].NewFileName);
            Assert.Equal("vacation.1.dng", outcomes[1].NewFileName);
            Assert.Equal("A", File.ReadAllText(Path.Combine(_dir, "vacation.dng")));
            Assert.Equal("B", File.ReadAllText(Path.Combine(_dir, "vacation.1.dng")));
        }

        [Fact]
        public async Task IdenticalRenderedName_IsReportedRelocatedAsANoOpWithoutTouchingTheFile()
        {
            var a = WriteItem("a", "img.dng", "bytes");

            var outcomes = await BatchRenameLogic.ApplySequentialAsync(
                new[] { a }, "{original}.{ext}", 0, 0, CollisionPolicy.Fail, FakeRender);

            Assert.Equal(BatchRenameOutcomeKind.Relocated, outcomes[0].Kind);
            Assert.Equal("img.dng", outcomes[0].NewFileName);
            Assert.True(File.Exists(Path.Combine(_dir, "img.dng")));
        }

        [Fact]
        public async Task OneItemsRenderFailure_DoesNotStopTheRemainingItems()
        {
            var a = WriteItem("a", "ok.dng", "A");
            var failing = WriteItem("bad", "bad.dng", "B"); // stem "bad" -> FakeRender rejects it
            var c = WriteItem("c", "ok2.dng", "C");

            var outcomes = await BatchRenameLogic.ApplySequentialAsync(
                new[] { a, failing, c }, "{original}_x.{ext}", 0, 0, CollisionPolicy.AutoSuffix, FakeRender);

            Assert.Equal(BatchRenameOutcomeKind.Relocated, outcomes[0].Kind);
            Assert.Equal(BatchRenameOutcomeKind.Invalid, outcomes[1].Kind);
            Assert.Equal("simulated per-item rejection", outcomes[1].Error);
            Assert.Equal(BatchRenameOutcomeKind.Relocated, outcomes[2].Kind);
            // The middle item's rejection left its file untouched and
            // didn't stop the third item from being renamed.
            Assert.True(File.Exists(Path.Combine(_dir, "bad.dng")));
            Assert.Equal("ok2_x.dng", outcomes[2].NewFileName);
        }

        [Fact]
        public async Task FailCollisionPolicy_RecordsErrorOutcomeAndContinues()
        {
            var a = WriteItem("a", "shot_a.dng", "A");
            var b = WriteItem("b", "shot_b.dng", "B");
            var c = WriteItem("c", "shot_c.dng", "C");

            var outcomes = await BatchRenameLogic.ApplySequentialAsync(
                new[] { a, b, c }, "same.{ext}", 0, 0, CollisionPolicy.Fail, FakeRender);

            Assert.Equal(BatchRenameOutcomeKind.Relocated, outcomes[0].Kind);
            Assert.Equal(BatchRenameOutcomeKind.Error, outcomes[1].Kind);
            Assert.Equal(BatchRenameOutcomeKind.Error, outcomes[2].Kind);
            // The batch kept going past the second item's failure — the
            // third was still attempted (and also collided, since the first
            // item still holds "same.dng").
            Assert.NotNull(outcomes[1].Error);
            Assert.NotNull(outcomes[2].Error);
        }

        [Fact]
        public async Task ProgressCallback_FiresOncePerItemInOrder()
        {
            var a = WriteItem("a", "a.dng", "A");
            var b = WriteItem("b", "b.dng", "B");
            var progress = new List<(int Done, int Total)>();

            await BatchRenameLogic.ApplySequentialAsync(
                new[] { a, b }, "{original}_x.{ext}", 0, 0, CollisionPolicy.AutoSuffix, FakeRender,
                (done, total) => progress.Add((done, total)));

            Assert.Equal(new[] { (1, 2), (2, 2) }, progress);
        }
    }
}
