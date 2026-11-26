using System.Threading;

namespace Maple.WinUI.Services
{
    internal static class RenderGate
    {
        public static readonly SemaphoreSlim Slots = new(LibraryHydration.RenderGateWidth);
    }
}
