using System;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Services;

internal static class DesktopFolderPicker
{
    // The WinRT broker returned E_FAIL after selection in the unpackaged
    // production shell (#3889). Use the desktop common dialog with its owner
    // HWND and filesystem result, without requiring StorageFolder activation.
    internal static string? Pick(IntPtr owner)
    {
        var dialog = (IFileDialog)new FileOpenDialog();
        try
        {
            dialog.GetOptions(out var options);
            dialog.SetOptions(options | 0x20 | 0x40 | 0x800 | 0x8);
            dialog.SetTitle("Select folder");
            var result = dialog.Show(owner);
            if (result == unchecked((int)0x800704C7)) return null;
            Marshal.ThrowExceptionForHR(result);
            dialog.GetResult(out var folder);
            try
            {
                folder.GetDisplayName(0x80058000, out var path); // SIGDN_FILESYSPATH
                try { return Marshal.PtrToStringUni(path); }
                finally { Marshal.FreeCoTaskMem(path); }
            }
            finally { Marshal.ReleaseComObject(folder); }
        }
        finally { Marshal.ReleaseComObject(dialog); }
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    // Preserve native vtable order, including methods not called by this picker.
    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, uint placement);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr value);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint format, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }
}
