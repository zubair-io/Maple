//! Stage-5 progress for the rotation tail (#5645). Composite spends minutes
//! before its first strip, so each long phase reports its own share of the
//! stage, and every report doubles as a cancellation checkpoint.

use std::cell::{Cell, RefCell};

use crate::composite::CompositePhase;
use crate::error::PanoError;

const COMPOSITE_STAGE: u32 = 5;
const MIN_STEP: f32 = 0.01;
const BELOW_STAGE_END: f32 = 0.99;

/// A phase's `(start, end)` share of stage 5.
pub(super) type Span = (f32, f32);

pub(super) const PHOTOMETRY: Span = (0.0, 0.10);
pub(super) const EXPOSURE_FIELD: Span = (0.10, 0.25);
const SURVEY: Span = (0.25, 0.60);
const STRIPS: Span = (0.60, 1.0);

fn span_of(phase: CompositePhase) -> Span {
    match phase {
        CompositePhase::Survey => SURVEY,
        CompositePhase::Strips => STRIPS,
    }
}

pub(super) struct CompositeProgress<'a> {
    emit: RefCell<&'a mut dyn FnMut(u32, f32)>,
    is_cancelled: &'a dyn Fn() -> bool,
    last: Cell<f32>,
}

impl<'a> CompositeProgress<'a> {
    pub fn new(emit: &'a mut dyn FnMut(u32, f32), is_cancelled: &'a dyn Fn() -> bool) -> Self {
        Self {
            emit: RefCell::new(emit),
            is_cancelled,
            last: Cell::new(0.0),
        }
    }

    /// Reports `fraction` of `span` as stage progress when it moves the
    /// bar by at least a hundredth, and never backwards; stage 5's own end
    /// is left to the caller.
    pub fn report(&self, (start, end): Span, fraction: f32) {
        let overall = (start + (end - start) * fraction.clamp(0.0, 1.0)).min(BELOW_STAGE_END);
        if overall >= self.last.get() + MIN_STEP {
            self.last.set(overall);
            (self.emit.borrow_mut())(COMPOSITE_STAGE, overall);
        }
    }

    pub fn report_phase(&self, phase: CompositePhase, fraction: f32) {
        self.report(span_of(phase), fraction);
    }

    /// An observer for a phase outside the sink: cancels, else reports.
    pub fn observer(&self, span: Span) -> impl FnMut(f32) -> Result<(), PanoError> + use<'_, 'a> {
        move |fraction| {
            if (self.is_cancelled)() {
                return Err(PanoError::Cancelled);
            }
            self.report(span, fraction);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_are_throttled_monotonic_and_stay_below_the_stage_end() {
        let seen = RefCell::new(Vec::new());
        let mut emit = |stage: u32, fraction: f32| seen.borrow_mut().push((stage, fraction));
        let never = || false;
        let progress = CompositeProgress::new(&mut emit, &never);
        for i in 0..=1000 {
            progress.report_phase(CompositePhase::Survey, i as f32 / 1000.0);
        }
        progress.report(PHOTOMETRY, 1.0);
        progress.report_phase(CompositePhase::Strips, 1.0);

        let seen = seen.into_inner();
        assert!(seen.iter().all(|&(stage, _)| stage == 5));
        assert!(seen.windows(2).all(|w| w[1].1 >= w[0].1 + MIN_STEP));
        assert!(seen.len() < 100, "throttled, got {}", seen.len());
        assert_eq!(seen.last().map(|&(_, f)| f), Some(BELOW_STAGE_END));
    }

    #[test]
    fn observer_fails_with_cancelled_once_cancelled() {
        let cancelled = Cell::new(false);
        let is_cancelled = || cancelled.get();
        let mut emit = |_: u32, _: f32| {};
        let progress = CompositeProgress::new(&mut emit, &is_cancelled);
        let mut observe = progress.observer(PHOTOMETRY);
        assert!(observe(0.5).is_ok());
        cancelled.set(true);
        assert!(matches!(observe(0.6), Err(PanoError::Cancelled)));
    }
}
