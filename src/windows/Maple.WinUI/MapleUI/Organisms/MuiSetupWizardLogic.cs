using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>One step of a Setup Wizard, with its current validity.
    /// Validity is domain-specific (a field filled in, a connection
    /// tested, …) and lives entirely with the caller — this record just
    /// carries the caller's verdict.</summary>
    public sealed record MuiWizardStepState(string Id, string Label, bool IsValid);

    /// <summary>
    /// The step-gating logic behind <see cref="MuiSetupWizard"/>
    /// (unified-component-catalog.md §4.8, "Setup Wizard" row:
    /// "Multi-step guided configuration" — this wave's brief calls for
    /// "validity-gated steps"). A step can only be reached — by Next or
    /// by clicking it directly in the <see cref="MuiProgressStep"/> list
    /// — once every step before it is valid; Next is disabled on an
    /// invalid current step so the wizard can never silently skip past
    /// missing input. Pure over <see cref="MuiWizardStepState"/> — unit
    /// tested without a live Window.
    /// </summary>
    public static class MuiSetupWizardLogic
    {
        public static bool CanAdvance(IReadOnlyList<MuiWizardStepState> steps, int currentIndex) =>
            currentIndex >= 0 && currentIndex < steps.Count && steps[currentIndex].IsValid;

        public static int NextIndex(IReadOnlyList<MuiWizardStepState> steps, int currentIndex) =>
            CanAdvance(steps, currentIndex) ? Math.Min(currentIndex + 1, steps.Count - 1) : currentIndex;

        public static int PreviousIndex(int currentIndex) => Math.Max(0, currentIndex - 1);

        /// <summary>True if every step strictly before <paramref name="targetIndex"/>
        /// is valid — i.e. jumping straight to it wouldn't skip an
        /// unfinished step.</summary>
        public static bool IsReachable(IReadOnlyList<MuiWizardStepState> steps, int targetIndex)
        {
            if (targetIndex < 0 || targetIndex >= steps.Count) return false;
            for (var i = 0; i < targetIndex; i++)
                if (!steps[i].IsValid) return false;
            return true;
        }

        public static bool IsComplete(IReadOnlyList<MuiWizardStepState> steps) => steps.Count > 0 && steps.All(s => s.IsValid);
    }
}
