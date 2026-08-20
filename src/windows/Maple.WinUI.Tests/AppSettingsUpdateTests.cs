// AppSettingsUpdateTests — exercises AppSettings' class-level INVARIANT
// (#2948): a partial write via Update() must never clobber a field some
// OTHER write landed since the last load. This is exactly the bug
// MainWindow's sidebar toggle had — Save()ing a `_settings` instance loaded
// once at construction reverted every LibraryFolders edit made mid-session,
// because that stale in-memory snapshot got serialized straight over the
// current file.
//
// Real file I/O against the real %LOCALAPPDATA%\Maple\settings.json —
// CLAUDE.md's "no mocks for the sidecar layer" reasoning applies here too:
// the invariant under test is specifically about what actually lands on
// disk, and a mock would let exactly this kind of bug through. Each test
// backs up whatever was there before it ran and restores it afterward, so a
// real dev machine's settings survive a local run; only this one test class
// touches AppSettings/that file, and xUnit runs tests within a class
// sequentially by default, so there's no cross-test file race.

using System;
using System.IO;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests
{
    public sealed class AppSettingsUpdateTests : IDisposable
    {
        private static string SettingsPath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Maple", "settings.json");

        private readonly bool _existedBefore;
        private readonly string? _originalContent;

        public AppSettingsUpdateTests()
        {
            _existedBefore = File.Exists(SettingsPath);
            _originalContent = _existedBefore ? File.ReadAllText(SettingsPath) : null;
        }

        public void Dispose()
        {
            if (_existedBefore)
                File.WriteAllText(SettingsPath, _originalContent!);
            else if (File.Exists(SettingsPath))
                File.Delete(SettingsPath);
        }

        [Fact]
        public void Update_ReloadsFirst_SoAWriteThatLandedSinceTheLastLoadSurvives()
        {
            // A clean starting point, standing in for "AppSettings.Load()
            // at app construction" — no LibraryFolders yet.
            new AppSettings().Save();

            // A write that lands AFTER that "launch load" — e.g.
            // AddLibraryFolder mid-session (EditSessionViewModel.Library.cs),
            // which already does its own fresh Load()+Save().
            var midSession = AppSettings.Load();
            midSession.LibraryFolders.Add(@"C:\Photos");
            midSession.Save();

            // Update()'s own write (e.g. OnToggleSidebar's LeftPanelHidden
            // toggle) must reload first, or it ships the pre-mid-session
            // snapshot and silently reverts the folder add above.
            AppSettings.Update(s => s.LeftPanelHidden = true);

            var final = AppSettings.Load();
            Assert.True(final.LeftPanelHidden);
            Assert.Equal(new[] { @"C:\Photos" }, final.LibraryFolders);
        }

        [Fact]
        public void Update_OnlyAppliesTheGivenMutation_LeavesEveryOtherFieldAsLoaded()
        {
            var seed = new AppSettings
            {
                LibraryFolders = { @"D:\Existing", @"E:\AlsoExisting" },
                DetailPanelHidden = true,
                LeftPanelWidth = 321,
                DetailPanelWidth = 555,
            };
            seed.Save();

            AppSettings.Update(s => s.LeftPanelHidden = true);

            var final = AppSettings.Load();
            Assert.True(final.LeftPanelHidden);
            Assert.True(final.DetailPanelHidden);
            Assert.Equal(321, final.LeftPanelWidth);
            Assert.Equal(555, final.DetailPanelWidth);
            Assert.Equal(new[] { @"D:\Existing", @"E:\AlsoExisting" }, final.LibraryFolders);
        }

        [Fact]
        public void SavingAStaleCachedInstanceDirectly_ReproducesTheBugUpdateAvoids()
        {
            // Demonstrates the #2948 hazard AppSettings.Update exists to
            // prevent — and exactly the pattern a future settings writer
            // must NOT reintroduce: a load held onto (mirroring
            // MainWindow._settings, loaded once at construction) and
            // Save()d directly, well after some other write has since
            // landed on disk.
            var cachedAtConstruction = AppSettings.Load();

            var midSession = AppSettings.Load();
            midSession.LibraryFolders.Add(@"C:\Added mid-session");
            midSession.Save();

            cachedAtConstruction.LeftPanelHidden = true;
            cachedAtConstruction.Save(); // the bug: reverts the add above

            var final = AppSettings.Load();
            Assert.True(final.LeftPanelHidden);
            Assert.DoesNotContain(@"C:\Added mid-session", final.LibraryFolders);
        }
    }
}
