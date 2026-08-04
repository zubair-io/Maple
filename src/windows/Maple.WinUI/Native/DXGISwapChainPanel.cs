using System;
using System.Runtime.InteropServices;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI.Native
{
    [ComImport]
    [Guid("63DB57F9-69E5-4216-861C-141428FA5D66")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISwapChainPanelNative
    {
        void SetSwapChain(IntPtr swapChain);
    }

    /// <summary>
    /// Helper to attach native DirectX 12 / DXGI SwapChain handles from `wgpu`
    /// directly to WinUI 3 `SwapChainPanel` controls.
    /// </summary>
    public static class DXGISwapChainPanelExtensions
    {
        public static void SetNativeSwapChain(this SwapChainPanel panel, IntPtr swapChainPtr)
        {
            if (panel == null) throw new ArgumentNullException(nameof(panel));
            
            var nativePanel = (ISwapChainPanelNative)(object)panel;
            nativePanel.SetSwapChain(swapChainPtr);
        }
    }
}
