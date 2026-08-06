using CommunityToolkit.Mvvm.ComponentModel;

namespace Maple.WinUI.ViewModels
{
    public partial class CullingWorkflowViewModel : ObservableObject
    {
        public void ApplyStarRating(AssetThumbnailItemViewModel item, int stars)
        {
            if (stars < 0 || stars > 5) return;
            item.StarRating = stars;
            // Write update to .xmp sidecar
        }

        public void ApplyFlag(AssetThumbnailItemViewModel item, string flag)
        {
            item.FlagStatus = flag; // Pick, Reject, None
            // Write update to .xmp sidecar
        }
    }
}
