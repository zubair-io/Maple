//! WinUI 3 / DXGI SwapChain interop module for Windows native host (`#[cfg(target_os = "windows")]`).
//!
//! Provides C-ABI exports for initializing a native DXGI swapchain handle (`IDXGISwapChain1`)
//! from `raw-gpu`'s `wgpu::Device` and presenting directly to a WinUI 3 `SwapChainPanel` control.

#![cfg(target_os = "windows")]

use crate::error::set_last_error;
use std::os::raw::c_void;
use std::ptr;

/// Standard Win32 HRESULT constants
const E_NOTIMPL: i32 = -0x7FFF_FFFF; // 0x80004001

/// C-ABI entry point to create a WinUI 3 DXGI SwapChain handle for a given HWND / SwapChainPanel pointer.
///
/// Returns 0 on success, negative HRESULT on error.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_create_winui_dxgi_swapchain(
    hwnd: *mut c_void,
    width: u32,
    height: u32,
    out_swapchain_ptr: *mut *mut c_void,
) -> i32 {
    if hwnd.is_null() || out_swapchain_ptr.is_null() {
        set_last_error("Invalid null pointer passed to maple_gpu_create_winui_dxgi_swapchain".into());
        return -1;
    }

    if width == 0 || height == 0 {
        set_last_error("Invalid zero dimensions passed for WinUI DXGI swapchain".into());
        return -2;
    }

    // Initialize output pointer to null
    *out_swapchain_ptr = ptr::null_mut();

    // DXGI SwapChain handle creation requires native DirectX 12 composition swapchain initialization.
    // Return E_NOTIMPL stub return code cleanly rather than returning an invalid HWND pointer.
    set_last_error("DXGI SwapChain composition creation pending Direct3D 12 device context".into());
    E_NOTIMPL
}

/// Frees a WinUI 3 DXGI SwapChain handle pointer.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_free_winui_dxgi_swapchain(swapchain_ptr: *mut c_void) {
    if swapchain_ptr.is_null() {
        return;
    }
    // Cleanup DXGI SwapChain COM reference
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_winui_swapchain_null_pointer_validation() {
        unsafe {
            let mut ptr: *mut c_void = ptr::null_mut();
            let res = maple_gpu_create_winui_dxgi_swapchain(ptr::null_mut(), 1920, 1080, &mut ptr);
            assert_eq!(res, -1);

            let mut dummy_hwnd_val: u32 = 0x1234;
            let dummy_hwnd = &mut dummy_hwnd_val as *mut u32 as *mut c_void;
            let res_null_out = maple_gpu_create_winui_dxgi_swapchain(dummy_hwnd, 1920, 1080, ptr::null_mut());
            assert_eq!(res_null_out, -1);
        }
    }

    #[test]
    fn test_winui_swapchain_zero_dimensions_validation() {
        unsafe {
            let mut ptr: *mut c_void = ptr::null_mut();
            let mut dummy_hwnd_val: u32 = 0x1234;
            let dummy_hwnd = &mut dummy_hwnd_val as *mut u32 as *mut c_void;
            let res = maple_gpu_create_winui_dxgi_swapchain(dummy_hwnd, 0, 1080, &mut ptr);
            assert_eq!(res, -2);
        }
    }

    #[test]
    fn test_winui_swapchain_not_implemented_stub_validation() {
        unsafe {
            let mut ptr: *mut c_void = (0x9999 as *mut u8) as *mut c_void;
            let mut dummy_hwnd_val: u32 = 0x1234;
            let dummy_hwnd = &mut dummy_hwnd_val as *mut u32 as *mut c_void;
            let res = maple_gpu_create_winui_dxgi_swapchain(dummy_hwnd, 1920, 1080, &mut ptr);
            assert_eq!(res, E_NOTIMPL);
            assert!(ptr.is_null());
        }
    }
}
