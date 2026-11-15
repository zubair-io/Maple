using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
using Maple.WinUI.Services.CloudFiles;
using Xunit;

namespace Maple.WinUI.Tests;

/// <summary>Opt-in native qualification for CFAPI. Run with
/// -p:MapleRunCloudFilesIntegration=true and a Windows/NTFS host. It creates
/// and unregisters only a unique temporary root; no Maple user data is used.</summary>
public sealed class CloudFilesRegistrationProbeTests
{
    private static readonly CfApi.CfCallback NoopCallback = static (_, _) => { };

    [Fact]
    public void TemporaryNtfsRootCreatesARealPlaceholder()
    {
        Assert.Equal(48, Marshal.SizeOf<CfApi.CF_FS_METADATA>());
        Assert.Equal(88, Marshal.SizeOf<CfApi.CF_PLACEHOLDER_CREATE_INFO>());
        Assert.Equal(80, Marshal.OffsetOf<CfApi.CF_PLACEHOLDER_CREATE_INFO>(nameof(CfApi.CF_PLACEHOLDER_CREATE_INFO.CreateUsn)).ToInt32());

        var root = Path.Combine(Path.GetTempPath(), "Maple-CfProbe-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var name = Marshal.StringToHGlobalUni("probe.dng");
        var identity = Marshal.StringToHGlobalUni("probe:probe.dng");
        var providerName = Marshal.StringToHGlobalUni("Maple probe");
        var providerVersion = Marshal.StringToHGlobalUni("test");
        var registered = false;
        long connection = 0;
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
                PopulationPrimary = CfApi.CF_POPULATION_POLICY_PARTIAL,
                InSync = CfApi.CF_INSYNC_POLICY_NONE,
                HardLink = CfApi.CF_HARDLINK_POLICY_NONE,
            };
            var registerHr = CfApi.CfRegisterSyncRoot(root, ref registration, ref policies, 0);
            Assert.True(registerHr == 0, $"CfRegisterSyncRoot HRESULT=0x{registerHr:X8}; FS={new DriveInfo(root).DriveFormat}");
            registered = true;
            var callback = Marshal.GetFunctionPointerForDelegate(NoopCallback);
            var connectHr = CfApi.CfConnectSyncRoot(root, new[]
            {
                new CfApi.CF_CALLBACK_REGISTRATION { Type = CfApi.CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS, Callback = callback },
                new CfApi.CF_CALLBACK_REGISTRATION { Type = CfApi.CF_CALLBACK_TYPE_FETCH_DATA, Callback = callback },
                new CfApi.CF_CALLBACK_REGISTRATION { Type = CfApi.CF_CALLBACK_TYPE_CANCEL_FETCH_DATA, Callback = callback },
                new CfApi.CF_CALLBACK_REGISTRATION { Type = CfApi.CF_CALLBACK_TYPE_NONE },
            }, IntPtr.Zero, CfApi.CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH, out connection);
            Assert.True(connectHr == 0, $"CfConnectSyncRoot HRESULT=0x{connectHr:X8}");
            Console.WriteLine($"CF probe connected: providerStatus=0x{ReadProviderStatus(root):X8}");

            var now = DateTime.UtcNow.ToFileTimeUtc();
            var entry = new CfApi.CF_PLACEHOLDER_CREATE_INFO
            {
                RelativeFileName = name,
                FsMetadata = new CfApi.CF_FS_METADATA
                {
                    FileSize = 12,
                    BasicInfo = new CfApi.FILE_BASIC_INFO
                    {
                        CreationTime = now, LastAccessTime = now, LastWriteTime = now, ChangeTime = now,
                        FileAttributes = 0x80,
                    },
                },
                FileIdentity = identity,
                FileIdentityLength = (uint)Encoding.Unicode.GetByteCount("probe:probe.dng"),
                Flags = CfApi.CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC,
            };
            var createHr = CfApi.CfCreatePlaceholders(root, new[] { entry }, 1, 0, out var processed);
            var path = Path.Combine(root, "probe.dng");
            var (attributes, tag) = ReadAttributeTag(path);
            var state = CfApi.CfGetPlaceholderStateFromAttributeTag(attributes, tag);
            var providerStatus = ReadProviderStatus(root);
            Console.WriteLine($"CF probe created: HRESULT=0x{createHr:X8} processed={processed} result=0x{entry.Result:X8} usn={entry.CreateUsn} attrs=0x{attributes:X8} tag=0x{tag:X8} state=0x{state:X8} providerStatus=0x{providerStatus:X8}");
            Assert.True(createHr == 0 && processed == 1 && entry.Result == 0 &&
                (state & CfApi.CF_PLACEHOLDER_STATE_PLACEHOLDER) != 0,
                $"CfCreatePlaceholders HRESULT=0x{createHr:X8}, EntriesProcessed={processed}, " +
                $"Result=0x{entry.Result:X8}, CreateUsn={entry.CreateUsn}, attributes=0x{attributes:X8}, " +
                $"reparseTag=0x{tag:X8}, state=0x{state:X8}, providerStatus=0x{providerStatus:X8}");

            var update = new PlaceholderEntry("probe.dng", "probe:probe.dng", false, 24, DateTime.UtcNow);
            Console.WriteLine("CF probe updating placeholder");
            Assert.True(CloudFilesChangeApply.UpdatePlaceholder(Path.Combine(root, "probe.dng"), update),
                "exclusive-oplock CfUpdatePlaceholder failed in the connected temporary root");
            Console.WriteLine("CF probe updated placeholder");
            Assert.True(CloudFilesPlaceholderProbe.IsInSyncPlaceholder(Path.Combine(root, "probe.dng")),
                "CfUpdatePlaceholder did not leave the placeholder in sync");
            Assert.Equal(RemovalOutcome.Removed,
                CloudFilesPlaceholderProbe.TryRemoveUnmodifiedPlaceholder(Path.Combine(root, "probe.dng")));
            Assert.False(File.Exists(Path.Combine(root, "probe.dng")));
        }
        finally
        {
            if (connection != 0) CfApi.CfDisconnectSyncRoot(connection);
            if (registered) CfApi.CfUnregisterSyncRoot(root);
            Marshal.FreeHGlobal(name);
            Marshal.FreeHGlobal(identity);
            Marshal.FreeHGlobal(providerName);
            Marshal.FreeHGlobal(providerVersion);
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static uint ReadProviderStatus(string root)
    {
        var info = new byte[CfApi.CF_SYNC_ROOT_PROVIDER_INFO_SIZE];
        var hr = CfApi.CfGetSyncRootInfoByPath(root, CfApi.CF_SYNC_ROOT_INFO_PROVIDER,
            info, (uint)info.Length, out _);
        return hr == 0 ? BitConverter.ToUInt32(info, 0) : unchecked((uint)hr);
    }

    private static (uint Attributes, uint Tag) ReadAttributeTag(string path)
    {
        using var handle = CreateFileW(path, 0x80, 0x7, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
        Assert.False(handle.IsInvalid, $"CreateFileW failed {Marshal.GetLastWin32Error()}");
        var info = new FileAttributeTagInfo();
        Assert.True(GetFileInformationByHandleEx(handle, 9, ref info, (uint)Marshal.SizeOf<FileAttributeTagInfo>()),
            $"GetFileInformationByHandleEx failed {Marshal.GetLastWin32Error()}");
        return (info.Attributes, info.ReparseTag);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo { public uint Attributes; public uint ReparseTag; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
        ref FileAttributeTagInfo info, uint size);
}
