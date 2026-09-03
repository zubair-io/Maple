// CapabilityRegistryTests — the Windows consumer of the generated capability
// registry (#2430). The registry is reviewed Rust
// (raw-core/src/capability_registry/) emitted by tools/codegen.sh; these
// tests pin what the WinUI shell relies on: stable ids, every
// Windows-shipped develop capability declared for Windows, and a release
// state that is never asserted by hand — no evidence source covers Windows
// yet, so nothing shipped here may read Released.

using System.Linq;
using Maple.WinUI.Generated;
using Xunit;

namespace Maple.WinUI.Tests
{
    public sealed class CapabilityRegistryTests
    {
        [Fact]
        public void IdsAreUniqueAndStable()
        {
            var ids = CapabilityRegistry.All.Select(c => c.Id).ToList();
            Assert.Equal(ids.Count, ids.Distinct().Count());
            foreach (var expected in new[] { "white_balance", "tone", "color", "detail", "geometry", "sidecar_persistence", "export" })
            {
                Assert.Contains(expected, ids);
            }
        }

        [Fact]
        public void EveryWindowsShippedDevelopCapabilityDeclaresWindows()
        {
            var windows = CapabilityRegistry.All
                .Where(c => c.Surfaces.Contains(CapabilitySurface.Windows))
                .Select(c => c.Id)
                .ToList();
            foreach (var id in new[] { "white_balance", "tone", "color", "detail", "geometry", "auto_adjustments" })
            {
                Assert.Contains(id, windows);
            }
        }

        [Fact]
        public void NothingShippedOnWindowsReadsReleasedWithoutWindowsEvidence()
        {
            // The registry declares no evidence source that covers Windows
            // (see raw-core's EvidenceSource::covers). Until one exists, a
            // Windows-shipped capability reading Released would mean the
            // rule was bypassed.
            foreach (var capability in CapabilityRegistry.All.Where(c => c.Surfaces.Contains(CapabilitySurface.Windows)))
            {
                Assert.NotEqual(CapabilityReleaseState.Released, capability.ReleaseState);
            }
        }

        [Fact]
        public void BuildIdentityIsPositive()
        {
            Assert.True(CapabilityRegistry.PipelineOutputVersion > 0);
            Assert.True(CapabilityRegistry.SchemaVersion > 0);
        }
    }
}
