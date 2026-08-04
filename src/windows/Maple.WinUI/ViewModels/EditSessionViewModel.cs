using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Native;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel : ObservableObject
    {
        [ObservableProperty]
        private float _exposure = 0.0f;

        [ObservableProperty]
        private float _contrast = 0.0f;

        [ObservableProperty]
        private float _highlights = 0.0f;

        [ObservableProperty]
        private float _shadows = 0.0f;

        [ObservableProperty]
        private float _vibrance = 0.0f;

        [ObservableProperty]
        private float _dehaze = 0.0f;

        public RawPipelineNative.MapleAdjustmentParams GetCurrentAdjustmentParams()
        {
            return new RawPipelineNative.MapleAdjustmentParams
            {
                Exposure = Exposure,
                Contrast = Contrast,
                Highlights = Highlights,
                Shadows = Shadows,
                Vibrance = Vibrance,
                Dehaze = Dehaze
            };
        }
    }
}
