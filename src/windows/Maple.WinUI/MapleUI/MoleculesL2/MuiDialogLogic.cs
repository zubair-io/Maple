namespace Maple.UI
{
    /// <summary>Which action closed a <see cref="MuiDialog"/>.</summary>
    public enum MuiDialogResultKind { Confirmed, Cancelled }

    /// <summary>The outcome of a Dialog interaction — <see cref="Value"/> is
    /// only meaningful for <see cref="MuiDialogResultKind.Confirmed"/> on
    /// the Prompt variant (empty on Confirm-variant dialogs, which have no
    /// input field, matching the web port's own "unused for confirm"
    /// note).</summary>
    public readonly record struct MuiDialogResult(MuiDialogResultKind Kind, string Value);

    /// <summary>
    /// Plain, WinUI-free result logic behind the Maple.UI Dialog molecule
    /// (unified-component-catalog.md §3, "Dialog" row). Same split as
    /// <see cref="MuiChipRowLogic"/>/<see cref="MuiInlineEditLogic"/>.
    ///
    /// Ports `mui-dialog.component.ts`'s <c>confirm()</c>/<c>cancel()</c>
    /// exactly — both are one-liners, but the same "trivial enough to still
    /// warrant its own testable seam" reasoning
    /// <see cref="MuiChipRowLogic"/>'s doc comment gives applies here: it's
    /// the one piece of Dialog's behavior that isn't itself a WinUI
    /// concern (scrim/Popup/focus), so it's the one piece this wave's test
    /// suite can exercise without a live Window.
    /// </summary>
    public static class MuiDialogLogic
    {
        /// <summary>Always emits the current prompt value verbatim — the
        /// caller (a Confirm-variant dialog) simply never wired anything to
        /// change it away from empty, mirroring `confirm()`'s unconditional
        /// `this.confirmed.emit(this.promptValue())`.</summary>
        public static MuiDialogResult Confirm(string promptValue) =>
            new(MuiDialogResultKind.Confirmed, promptValue ?? string.Empty);

        public static MuiDialogResult Cancel() =>
            new(MuiDialogResultKind.Cancelled, string.Empty);
    }
}
