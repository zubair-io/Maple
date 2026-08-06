// RepoPaths — locates the repo root and the shared XMP golden corpus from
// inside a test run, so fixture-gated tests can skip-pass when the corpus
// isn't present (test-fixtures/* is gitignored — see .gitignore and
// CLAUDE.md's "Objective color testing" section for the same convention
// applied to src/scripts/test_color_pipeline.sh).

using System;
using System.IO;
using System.Linq;

namespace Maple.WinUI.Tests.Support
{
    internal static class RepoPaths
    {
        /// <summary>
        /// Walk up from the test assembly's output directory until a folder
        /// containing both `CLAUDE.md` and `src/` is found — that is this
        /// worktree's repo root. Returns null if no such ancestor exists
        /// (shouldn't happen in a normal checkout, but a test run must never
        /// throw just because a fixture lookup failed).
        /// </summary>
        public static string? FindRepoRoot()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null)
            {
                var claudeMd = Path.Combine(dir.FullName, "CLAUDE.md");
                var srcDir = Path.Combine(dir.FullName, "src");
                if (File.Exists(claudeMd) && Directory.Exists(srcDir))
                {
                    return dir.FullName;
                }
                dir = dir.Parent;
            }
            return null;
        }

        /// <summary>
        /// `test-fixtures/sidecars/` if the repo root was found AND the
        /// directory exists AND it contains at least one `.xmp` file;
        /// otherwise null. The directory is gitignored (6.5GB of RAW/ACR
        /// fixtures live under the same `test-fixtures/*` gitignore rule),
        /// so a fresh clone or a hosted CI runner without the corpus fetched
        /// locally is the expected common case, not an error.
        /// </summary>
        public static string? SidecarCorpusDirOrNull()
        {
            var root = FindRepoRoot();
            if (root is null) return null;
            var dir = Path.Combine(root, "test-fixtures", "sidecars");
            if (!Directory.Exists(dir)) return null;
            return Directory.EnumerateFiles(dir, "*.xmp", SearchOption.AllDirectories).Any()
                ? dir
                : null;
        }
    }
}
