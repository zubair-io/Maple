using System;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Services
{
    public static class CloudFilesProvider
    {
        private const string CfApiDll = "cldapi.dll";

        [DllImport(CfApiDll, CharSet = CharSet.Unicode, ExactSpelling = true)]
        public static extern int CfRegisterSyncRoot(
            string syncRootPath,
            IntPtr registrationInfo,
            IntPtr policies,
            uint registerFlags);

        [DllImport(CfApiDll, CharSet = CharSet.Unicode, ExactSpelling = true)]
        public static extern int CfUnregisterSyncRoot(string syncRootPath);

        public static bool RegisterMapleCloudProvider(string syncFolderPath)
        {
            if (string.IsNullOrWhiteSpace(syncFolderPath))
                return false;

            try
            {
                // Native cfapi registration entrypoint stub for Windows File Explorer cloud provider
                System.Diagnostics.Debug.WriteLine($"Registering Windows Cloud Files Provider at {syncFolderPath}");
                return true;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"CfRegisterSyncRoot failed: {ex.Message}");
                return false;
            }
        }
    }
}
