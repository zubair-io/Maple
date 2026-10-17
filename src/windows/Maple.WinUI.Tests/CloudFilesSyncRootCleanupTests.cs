// CloudFilesSyncRootCleanupTests — what disabling the Explorer sync root
// may and may not remove from %USERPROFILE%\Maple Cloud (#4756). Before
// this, Stop(unregister: true) was Directory.Delete(root, recursive: true),
// which destroyed Explorer-side writes (never uploaded by design) and
// modified hydrated copies. The sweep removes only items the caller's
// placeholder probe vouches for and leaves everything else in place; the
// probe itself is cldapi (CfGetPlaceholderStateFromAttributeTag) and is
// substituted here, the same split CloudFilesHydrationTests relies on.

using System;
using System.Collections.Generic;
using System.IO;
using Maple.WinUI.Services.CloudFiles;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class CloudFilesSyncRootCleanupTests : IDisposable
    {
        private readonly string _root = Path.Combine(
            Path.GetTempPath(), "maple-cloudfiles-cleanup-" + Guid.NewGuid().ToString("N"));
        private readonly HashSet<string> _placeholders = new(StringComparer.Ordinal);
        private readonly HashSet<string> _unpopulatedDirectories = new(StringComparer.Ordinal);

        public void Dispose()
        {
            if (Directory.Exists(_root))
                Directory.Delete(_root, recursive: true);
        }

        private string Write(string relative, bool placeholder)
        {
            // The sweep enumerates with the platform separator; the key
            // must match it on Windows too, so it is built from segments.
            var path = Path.Combine(_root, Path.Combine(relative.Split('/')));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, relative);
            if (placeholder)
                _placeholders.Add(Path.GetFullPath(path));
            return path;
        }

        private bool IsUnmodifiedPlaceholder(string path) => _placeholders.Contains(Path.GetFullPath(path));

        private CleanupProbes Probes => new(
            IsUnmodifiedPlaceholder,
            path => _unpopulatedDirectories.Contains(Path.GetFullPath(path)));

        private CleanupResult Sweep() => CloudFilesSyncRootCleanup.Sweep(_root, Probes);

        [Fact]
        public void NonPlaceholderFileSurvivesDisable()
        {
            var local = Write("Library/local-only.jpg", placeholder: false);
            var cloud = Write("Library/cloud.jpg", placeholder: true);

            var result = Sweep();

            Assert.True(File.Exists(local));
            Assert.False(File.Exists(cloud));
            Assert.True(Directory.Exists(_root));
            Assert.Equal(1, result.Removed);
            Assert.Equal(1, result.Preserved);
        }

        [Fact]
        public void ModifiedHydratedCopySurvivesDisable()
        {
            // A hydrated placeholder the user edited is reported as not
            // in-sync by the probe — it must be treated like any local file.
            var edited = Write("Library/edited.dng", placeholder: false);

            Sweep();

            Assert.True(File.Exists(edited));
        }

        [Fact]
        public void OnlyPlaceholders_RemovesTheWholeTreeIncludingRoot()
        {
            Write("Library/a.jpg", placeholder: true);
            Write("Library/2024/b.jpg", placeholder: true);
            Directory.CreateDirectory(Path.Combine(_root, "Other", "Empty"));

            var result = Sweep();

            Assert.False(Directory.Exists(_root));
            Assert.Equal(2, result.Removed);
            Assert.Equal(0, result.Preserved);
        }

        [Fact]
        public void PreservedFileKeepsItsAncestorDirectories_SiblingsStillPruned()
        {
            var keep = Write("Library/2024/keep.txt", placeholder: false);
            Write("Library/2024/gone.jpg", placeholder: true);
            Write("Library/2023/gone.jpg", placeholder: true);

            Sweep();

            Assert.True(File.Exists(keep));
            Assert.True(Directory.Exists(Path.Combine(_root, "Library", "2024")));
            Assert.False(Directory.Exists(Path.Combine(_root, "Library", "2023")));
        }

        [Fact]
        public void ProbeFailure_PreservesTheItem()
        {
            // An unreadable attribute tag is not evidence the file is a
            // placeholder; when in doubt, keep it.
            var path = Write("Library/odd.jpg", placeholder: true);

            var result = CloudFilesSyncRootCleanup.Sweep(
                _root, new CleanupProbes(_ => throw new IOException("probe failed"), _ => false));

            Assert.True(File.Exists(path));
            Assert.Equal(1, result.Preserved);
        }

        [Fact]
        public void DirectoryReparsePoint_IsKeptAndNotEntered()
        {
            // A junction/symlink inside Maple Cloud resolves elsewhere; its
            // target may even be another provider's sync root whose in-sync
            // placeholders would pass the probe. Nothing behind it may go.
            var outside = Path.Combine(_root + "-outside");
            Directory.CreateDirectory(outside);
            var outsideFile = Path.Combine(outside, "theirs.jpg");
            File.WriteAllText(outsideFile, "theirs");
            Directory.CreateDirectory(_root);
            var link = Path.Combine(_root, "Linked");
            Directory.CreateSymbolicLink(link, outside);
            // The probe approves it however it is reached — through the
            // link is the path a sweep that wrongly descends would see.
            _placeholders.Add(Path.GetFullPath(outsideFile));
            _placeholders.Add(Path.GetFullPath(Path.Combine(link, "theirs.jpg")));
            try
            {
                var result = Sweep();

                Assert.True(File.Exists(outsideFile));
                Assert.True(Directory.Exists(link));
                Assert.True(Directory.Exists(_root));
                Assert.Equal(0, result.Removed);
                Assert.Equal(1, result.Preserved);
            }
            finally
            {
                Directory.Delete(outside, recursive: true);
            }
        }

        [Fact]
        public void UnpopulatedPlaceholderDirectory_IsRemovedWithoutBeingEntered()
        {
            // Never opened in Explorer: nothing local beneath it, and
            // enumerating it would cost a FETCH_PLACEHOLDERS round-trip.
            var unopened = Path.Combine(_root, "Library", "2019");
            Directory.CreateDirectory(unopened);
            _unpopulatedDirectories.Add(Path.GetFullPath(unopened));

            var result = Sweep();

            Assert.False(Directory.Exists(unopened));
            Assert.False(Directory.Exists(_root));
            Assert.Equal(1, result.Removed);
        }

        [Fact]
        public void ApprovedDirectoryThatStillHoldsLocalContent_FallsBackToTheWalk()
        {
            // The probe can be stale; a directory with anything inside
            // cannot be removed outright, so it is swept item by item.
            var keep = Write("Library/2019/mine.txt", placeholder: false);
            _unpopulatedDirectories.Add(Path.GetFullPath(Path.Combine(_root, "Library", "2019")));

            var result = Sweep();

            Assert.True(File.Exists(keep));
            Assert.Equal(1, result.Preserved);
        }

        [Fact]
        public void DeleteFailure_KeepsTheItemAndTheSweepCarriesOn()
        {
            // A locked or protected placeholder must not abort the sweep —
            // the caller unregisters afterwards whatever happened here.
            var stuck = Write("Library/stuck.jpg", placeholder: true);
            var other = Write("Library/other.jpg", placeholder: true);
            var stuckDir = Path.GetDirectoryName(stuck)!;
            File.SetAttributes(stuck, FileAttributes.ReadOnly);
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(stuckDir, UnixFileMode.UserRead | UnixFileMode.UserExecute);
            try
            {
                var result = Sweep();

                // Windows refuses the read-only file alone; Unix refuses
                // both via the read-only parent. Either way: no throw, the
                // stuck file stays, every item is accounted for.
                Assert.True(File.Exists(stuck));
                Assert.True(Directory.Exists(_root));
                Assert.True(result.Preserved >= 1);
                Assert.Equal(2, result.Removed + result.Preserved);
                Assert.Equal(File.Exists(other), result.Removed == 0);
            }
            finally
            {
                if (!OperatingSystem.IsWindows())
                    File.SetUnixFileMode(stuckDir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
                File.SetAttributes(stuck, FileAttributes.Normal);
            }
        }

        [Fact]
        public void MissingRoot_IsANoOp()
        {
            var result = Sweep();

            Assert.Equal(0, result.Removed);
            Assert.Equal(0, result.Preserved);
        }

        [Fact]
        public void Adoption_RefusesNonEmptyFolderThatIsNotMaplesSyncRoot()
        {
            Write("holiday.jpg", placeholder: false);

            var refusal = CloudFilesSyncRootCleanup.AdoptionRefusal(_root, isMapleSyncRoot: false);

            Assert.NotNull(refusal);
            Assert.Contains("Maple Cloud", refusal);
        }

        [Fact]
        public void Adoption_AcceptsMissingEmptyOrRegisteredFolder()
        {
            Assert.Null(CloudFilesSyncRootCleanup.AdoptionRefusal(_root, isMapleSyncRoot: false));

            Directory.CreateDirectory(_root);
            Assert.Null(CloudFilesSyncRootCleanup.AdoptionRefusal(_root, isMapleSyncRoot: false));

            Write("Library/cloud.jpg", placeholder: true);
            Assert.Null(CloudFilesSyncRootCleanup.AdoptionRefusal(_root, isMapleSyncRoot: true));
        }
    }
}
