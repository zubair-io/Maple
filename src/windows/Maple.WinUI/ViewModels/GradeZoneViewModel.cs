using System;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Models;

namespace Maple.WinUI.ViewModels
{
    /// <summary>One color-grading wheel zone (Shadows / Midtones / Highlights /
    /// Global) bound to its hue+sat model fields. The shadow/highlight zones
    /// deliberately ride the ACR SplitToning fields; midtones/global use the
    /// ColorGrade fields — same mapping as the web panel.</summary>
    public partial class GradeZoneViewModel : ObservableObject
    {
        private readonly EditSessionViewModel _session;
        private readonly Func<AdjustmentState, double> _getHue;
        private readonly Action<AdjustmentState, double> _setHue;
        private readonly Func<AdjustmentState, double> _getSat;
        private readonly Action<AdjustmentState, double> _setSat;

        public string Name { get; }

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(ValueText))]
        private double _hue;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(ValueText))]
        private double _saturation;

        /// <summary>Caption under the wheel, e.g. "180° · 42".</summary>
        public string ValueText => $"{Hue:0}° · {Saturation:0}";

        public GradeZoneViewModel(
            EditSessionViewModel session, string name,
            Func<AdjustmentState, double> getHue, Action<AdjustmentState, double> setHue,
            Func<AdjustmentState, double> getSat, Action<AdjustmentState, double> setSat)
        {
            _session = session;
            Name = name;
            _getHue = getHue;
            _setHue = setHue;
            _getSat = getSat;
            _setSat = setSat;
            _hue = getHue(session.Adjustments);
            _saturation = getSat(session.Adjustments);
        }

        /// <summary>Absolute wheel write — both fields in one edit (one render
        /// request, one undo boundary).</summary>
        public void ApplyWheel(double hue, double saturation)
        {
            Hue = hue;
            Saturation = saturation;
            _setHue(_session.Adjustments, hue);
            _setSat(_session.Adjustments, saturation);
            _session.NotifyAdjustmentEdited();
        }

        /// <summary>Double-tap reset: saturation 0 is the identity, hue is
        /// discarded with it (web wheel dblclick behavior).</summary>
        public void Reset() => ApplyWheel(0, 0);

        public void SyncFromModel()
        {
            Hue = _getHue(_session.Adjustments);
            Saturation = _getSat(_session.Adjustments);
        }
    }
}
