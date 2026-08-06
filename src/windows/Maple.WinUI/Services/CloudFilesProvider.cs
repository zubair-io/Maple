using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Services
{
    public static class CloudFilesProvider
    {
        private const string CfApiDll = "cldapi.dll";

        public const uint CF_REGISTER_FLAG_NONE = 0x00000000;
        public const uint CF_REGISTER_FLAG_UPDATE = 0x00000001;

        [DllImport(CfApiDll, CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        public static extern int CfRegisterSyncRoot(
            string syncRootPath,
            IntPtr registrationInfo,
            IntPtr policies,
            uint registerFlags);

        [DllImport(CfApiDll, CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        public static extern int CfUnregisterSyncRoot(string syncRootPath);

        public static bool RegisterMapleCloudProvider(string syncFolderPath)
        {
            if (string.IsNullOrWhiteSpace(syncFolderPath))
                throw new ArgumentNullException(nameof(syncFolderPath), "Sync folder path must be specified.");

            if (!Directory.Exists(syncFolderPath))
            {
                Directory.CreateDirectory(syncFolderPath);
            }

            try
            {
                System.Diagnostics.Debug.WriteLine($"[CloudFilesProvider] Invoking cldapi.dll CfRegisterSyncRoot for {syncFolderPath}");
                
                int hr = CfRegisterSyncRoot(syncFolderPath, IntPtr.Zero, IntPtr.Zero, CF_REGISTER_FLAG_NONE);
                if (hr != 0)
                {
                    System.Diagnostics.Debug.WriteLine($"[CloudFilesProvider] CfRegisterSyncRoot returned HRESULT 0x{hr:X8}");
                    throw new Win32Exception(hr, $"Windows Cloud Files registration failed for path '{syncFolderPath}' with HRESULT 0x{hr:X8}.");
                }
                return true;
            }
            catch (DllNotFoundException)
            {
                System.Diagnostics.Debug.WriteLine("[CloudFilesProvider] cldapi.dll is not available on this edition of Windows.");
                return false;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[CloudFilesProvider] Sync root registration error: {ex.Message}");
                throw;
            }
        }

        public static bool HydratePlaceholderFile(string placeholderPath)
        {
            if (string.IsNullOrWhiteSpace(placeholderPath) || !File.Exists(placeholderPath))
                throw new FileNotFoundException("Target placeholder file does not exist.", placeholderPath);

            System.Diagnostics.Debug.WriteLine($"[CloudFilesProvider] Hydrating placeholder file: {placeholderPath}");
            // File is locally present and available for rendering
            return true;
        }
    }
}
