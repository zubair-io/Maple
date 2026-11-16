/// What the Auto Profile fit achieved for one image (#4096, #5458). Every
/// outcome other than `Applied` renders exactly as Neutral, except `Cancelled`
/// which asks the host to discard the operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoFitOutcome {
    Applied,
    /// No embedded camera preview could be extracted, so there was nothing to
    /// fit against.
    NoPreview,
    /// A degenerate fit, a failed develop or read, or Auto disabled.
    Unfitted,
    /// The host abandoned the fit during develop, pair sampling, or between fit phases.
    Cancelled,
}

impl AutoFitOutcome {
    pub const ALL: [Self; 3] = [Self::Applied, Self::NoPreview, Self::Unfitted];

    /// The C-FFI fit return code for [`Self::NoPreview`], emitted to C# by
    /// codegen and pinned by raw-ffi's `MAPLE_AUTO_FIT_NO_PREVIEW`.
    pub const NO_PREVIEW_FFI_CODE: i32 = 10;
    /// C-FFI code for host-requested cancellation of a cancellable fit entry.
    pub const CANCELLED_FFI_CODE: i32 = 11;

    /// The wire name WASM hands the browser host.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::NoPreview => "no-preview",
            Self::Unfitted => "unfitted",
            Self::Cancelled => "cancelled",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AutoFitOutcome;

    #[test]
    fn all_lists_every_outcome_once() {
        let position = |outcome| match outcome {
            AutoFitOutcome::Applied => 0,
            AutoFitOutcome::NoPreview => 1,
            AutoFitOutcome::Unfitted => 2,
            AutoFitOutcome::Cancelled => 3,
        };
        assert!(
            AutoFitOutcome::ALL
                .iter()
                .enumerate()
                .all(|(index, &outcome)| position(outcome) == index)
        );
    }
}
