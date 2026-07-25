//! `LensProfileEnable` — the master switch for DNG-embedded lens
//! corrections (#376). Split out of `adjustment/mod.rs` to stay under the
//! 600-LOC hard budget (#1181).

/// Master on/off for the lens corrections a DNG carries in its
/// `OpcodeList3` (#376).
///
/// ACR writes this as `crs:LensProfileEnable="1"` / `="0"`, and its `="0"`
/// state overrides the three per-family scales — a sidecar authored with
/// lens corrections switched off must not have them silently reapplied
/// just because the scales still read 100.
///
/// Default is `On`, matching ACR: when a DNG embeds the vendor's own
/// corrections they are applied unless the user opts out. A RAW with no
/// `OpcodeList3` has nothing to apply, so the default is a no-op there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LensProfileEnable {
    /// Skip every `OpcodeList3` lens correction regardless of the scales.
    Off,
    /// Apply each correction family at its own scale (default).
    On,
}

impl Default for LensProfileEnable {
    fn default() -> Self {
        Self::On
    }
}
