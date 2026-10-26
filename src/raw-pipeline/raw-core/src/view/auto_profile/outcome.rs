/// What the Auto Profile fit achieved for one image (#4096, #5458). Every
/// outcome other than `Applied` renders exactly as Neutral.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoFitOutcome {
    Applied,
    /// No embedded camera preview could be extracted, so there was nothing to
    /// fit against.
    NoPreview,
    /// A preview was available, but no usable curve or residual came out of
    /// the fit (a degenerate pairing, a failed develop, or Auto disabled).
    Unfitted,
}

impl AutoFitOutcome {
    /// The outcome of a fit attempt that produced `applied` artifacts, given
    /// whether any preview (or cached fit) was available to it.
    pub fn of(applied: bool, preview_available: bool) -> Self {
        match (applied, preview_available) {
            (true, _) => Self::Applied,
            (false, false) => Self::NoPreview,
            (false, true) => Self::Unfitted,
        }
    }

    /// The wire name WASM hands the browser host.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::NoPreview => "no-preview",
            Self::Unfitted => "unfitted",
        }
    }
}
