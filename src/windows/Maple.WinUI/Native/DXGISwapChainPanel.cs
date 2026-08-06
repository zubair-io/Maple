using System;
using System.Runtime.InteropServices;
using Microsoft.UI.Xaml.Controls;
using WinRT;

namespace Maple.WinUI.Native
{
    [ComImport]
    [Guid("63820000-8D6F-4160-9B4F-5E43ED3A6036")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISwapChainPanelNative
    {
        void SetSwapChain(IntPtr swapChain);
    }

    public static class DXGISwapChainBridge
    {
        public static void AttachSwapChain(SwapChainPanel panel, IntPtr swapChainPtr)
        {
            if (panel == null || swapChainPtr == IntPtr.Zero)
                return;

            try
            {
                var panelNative = panel.As<ISwapChainPanelNative>();
                panelNative?.SetSwapChain(swapChainPtr);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to attach DXGI SwapChain: {ex.Message}");
            }
        }
    }
}
