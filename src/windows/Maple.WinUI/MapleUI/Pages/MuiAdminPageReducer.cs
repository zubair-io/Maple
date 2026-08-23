using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageAdmin</c>'s cross-organism wiring (#3012) — the Setup
    /// Wizard only allows "Finish" once every step reports itself valid
    /// (the wizard's own <c>StepValidity</c> contract), and a Pipeline
    /// Monitor stage that has already finished every unit of work can no
    /// longer be paused/resumed — there's nothing left to pause.</summary>
    public static class MuiAdminPageReducer
    {
        public static bool CanFinish(IReadOnlyList<bool> stepValidity) =>
            stepValidity.Count > 0 && stepValidity.All(v => v);

        public static bool TogglePause(bool currentlyPaused, int done, int total) =>
            done >= total ? false : !currentlyPaused;
    }
}
