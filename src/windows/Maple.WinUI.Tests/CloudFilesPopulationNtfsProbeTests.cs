using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using Maple.WinUI.Services.CloudFiles;
using Xunit;

namespace Maple.WinUI.Tests
{
    /// <summary>Opt-in, live Cloud Files API check on a fresh isolated NTFS
    /// sync root. Set MAPLE_CLOUD_FILES_POPULATION_PROBE=1 to run it.</summary>
    public sealed class CloudFilesPopulationNtfsProbeTests
    {
        private const string ProbeSwitch = "MAPLE_CLOUD_FILES_POPULATION_PROBE";
        private const uint FileAttributeDirectory = 0x10;
        private const uint FileAttributeNormal = 0x80;
        private const uint PlaceholderMarkInSync = 2;

        [DllImport("cldapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int CfCreatePlaceholders(
            string baseDirectoryPath,
            [In, Out] CfApi.CF_PLACEHOLDER_CREATE_INFO[] placeholderArray,
            uint placeholderCount,
            uint createFlags,
            out uint entriesProcessed);

        [Fact]
        public void IsolatedNtfsRoot_RegistersFullPolicyAndCreatesDisambiguatedNames()
        {
            if (!OperatingSystem.IsWindows() || Environment.GetEnvironmentVariable(ProbeSwitch) != "1")
                return;

            var root = Path.Combine(Path.GetTempPath(), $"Maple-CFAPI-5855-{Guid.NewGuid():N}");
            var parent = Path.Combine(root, "probe-parent");
            if (!string.Equals(new DriveInfo(Path.GetPathRoot(root)!).DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The opt-in Cloud Files probe requires an NTFS temp volume.");

            Directory.CreateDirectory(root);
            var providerName = Marshal.StringToHGlobalUni("Maple 5855 Probe");
            var providerVersion = Marshal.StringToHGlobalUni("1.0");
            var registered = false;
            try
            {
                var registration = new CfApi.CF_SYNC_REGISTRATION
                {
                    StructSize = (uint)Marshal.SizeOf<CfApi.CF_SYNC_REGISTRATION>(),
                    ProviderName = providerName,
                    ProviderVersion = providerVersion,
                    ProviderId = Guid.NewGuid(),
                };
                var policies = new CfApi.CF_SYNC_POLICIES
                {
                    StructSize = (uint)Marshal.SizeOf<CfApi.CF_SYNC_POLICIES>(),
                    HydrationPrimary = CfApi.CF_HYDRATION_POLICY_FULL,
                    PopulationPrimary = CfApi.CF_POPULATION_POLICY_FULL,
                    InSync = CfApi.CF_INSYNC_POLICY_NONE,
                    HardLink = CfApi.CF_HARDLINK_POLICY_NONE,
                };
                Assert.Equal(0, CfApi.CfRegisterSyncRoot(
                    root, ref registration, ref policies, CfApi.CF_REGISTER_FLAG_UPDATE));
                registered = true;

                var syncInfo = new byte[4096];
                Assert.Equal(0, CfApi.CfGetSyncRootInfoByPath(
                    root, 1, syncInfo, (uint)syncInfo.Length, out var returnedLength));
                Assert.True(returnedLength >= 16);
                Assert.Equal((ushort)CfApi.CF_POPULATION_POLICY_FULL, BitConverter.ToUInt16(syncInfo, 12));

                CreatePlaceholder(root, "probe-parent", "probe:directory", directory: true);

                var source = new[]
                {
                    new PlaceholderEntry("IMG.JPG", "probe:upper", false, 1, DateTime.UtcNow),
                    new PlaceholderEntry("img.JPG", "probe:lower", false, 1, DateTime.UtcNow),
                };
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var entries = CloudFilesListing.WithUniqueWindowsNames(source, names);
                Assert.Equal(2, entries.Select(entry => entry.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count());
                CreatePlaceholders(parent, entries);

                var created = Directory.EnumerateFileSystemEntries(parent).Select(Path.GetFileName).ToArray();
                Assert.Equal(2, created.Length);
                Assert.Contains("IMG.JPG", created, StringComparer.OrdinalIgnoreCase);
                Assert.Contains(created, name => name!.StartsWith("img (", StringComparison.OrdinalIgnoreCase));
            }
            finally
            {
                if (registered)
                    CfApi.CfUnregisterSyncRoot(root);
                Marshal.FreeHGlobal(providerName);
                Marshal.FreeHGlobal(providerVersion);

                // Only this test's fresh, uniquely named temp directory is ever removed.
                if (Directory.Exists(root) && Path.GetFileName(root).StartsWith("Maple-CFAPI-5855-", StringComparison.Ordinal))
                    Directory.Delete(root, recursive: true);
            }
        }

        private static void CreatePlaceholder(string basePath, string name, string identity, bool directory)
        {
            var namePtr = Marshal.StringToHGlobalUni(name);
            var identityPtr = Marshal.StringToHGlobalUni(identity);
            try
            {
                var entry = new CfApi.CF_PLACEHOLDER_CREATE_INFO
                {
                    RelativeFileName = namePtr,
                    FileIdentity = identityPtr,
                    FileIdentityLength = (uint)(identity.Length * sizeof(char)),
                    Flags = PlaceholderMarkInSync,
                    FsMetadata = new CfApi.CF_FS_METADATA
                    {
                        BasicInfo = new CfApi.FILE_BASIC_INFO
                        {
                            FileAttributes = directory ? FileAttributeDirectory : FileAttributeNormal,
                        },
                    },
                };
                var hr = CfCreatePlaceholders(basePath, new[] { entry }, 1, 0, out var processed);
                Assert.Equal(0, hr);
                Assert.Equal(1u, processed);
                Assert.Equal(0, entry.Result);
            }
            finally
            {
                Marshal.FreeHGlobal(namePtr);
                Marshal.FreeHGlobal(identityPtr);
            }
        }

        private static void CreatePlaceholders(string basePath, IReadOnlyList<PlaceholderEntry> entries)
        {
            var pointers = new List<IntPtr>(entries.Count * 2);
            var nativeEntries = new CfApi.CF_PLACEHOLDER_CREATE_INFO[entries.Count];
            try
            {
                for (var i = 0; i < entries.Count; i++)
                {
                    var entry = entries[i];
                    var name = Marshal.StringToHGlobalUni(entry.Name);
                    var identity = Marshal.StringToHGlobalUni(entry.Address);
                    pointers.Add(name);
                    pointers.Add(identity);
                    nativeEntries[i] = new CfApi.CF_PLACEHOLDER_CREATE_INFO
                    {
                        RelativeFileName = name,
                        FileIdentity = identity,
                        FileIdentityLength = (uint)(entry.Address.Length * sizeof(char)),
                        Flags = PlaceholderMarkInSync,
                        FsMetadata = new CfApi.CF_FS_METADATA
                        {
                            FileSize = entry.Size,
                            BasicInfo = new CfApi.FILE_BASIC_INFO { FileAttributes = FileAttributeNormal },
                        },
                    };
                }

                var hr = CfCreatePlaceholders(basePath, nativeEntries, (uint)nativeEntries.Length, 0, out var processed);
                Assert.Equal(0, hr);
                Assert.Equal((uint)entries.Count, processed);
                Assert.All(nativeEntries, entry => Assert.Equal(0, entry.Result));
            }
            finally
            {
                foreach (var pointer in pointers)
                    Marshal.FreeHGlobal(pointer);
            }
        }
    }
}
