// Windows Cloud Files API (cldapi.dll) interop for the Maple Cloud sync
// root (#2589). Hand-declared rather than generated: the app takes no
// interop-generator dependency, and only the small surface the provider
// actually uses is declared — register/unregister, connect/disconnect, and
// the CfExecute responses to the two callbacks we serve
// (FETCH_PLACEHOLDERS, FETCH_DATA).
//
// Struct layouts follow cfapi.h on x64 (Pack = 8). The
// CF_OPERATION_PARAMETERS variants are declared as separate structs — the
// native type is a union behind a ULONG ParamSize, and the union starts at
// offset 8, which the explicit `_pad` fields reproduce.

using System;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Services.CloudFiles
{
    internal static class CfApi
    {
        private const string Dll = "cldapi.dll";

        // --- CF_CALLBACK_TYPE (cfapi.h) ---
        internal const int CF_CALLBACK_TYPE_FETCH_DATA = 0;
        internal const int CF_CALLBACK_TYPE_CANCEL_FETCH_DATA = 2;
        internal const int CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS = 3;
        internal const int CF_CALLBACK_TYPE_NOTIFY_DELETE = 9;
        internal const int CF_CALLBACK_TYPE_NOTIFY_RENAME = 11;
        internal const int CF_CALLBACK_TYPE_NONE = unchecked((int)0xFFFFFFFF);

        // --- policies ---
        internal const ushort CF_HYDRATION_POLICY_FULL = 2;
        internal const ushort CF_POPULATION_POLICY_FULL = 2;
        internal const uint CF_INSYNC_POLICY_NONE = 0;
        internal const uint CF_HARDLINK_POLICY_NONE = 0;

        internal const uint CF_REGISTER_FLAG_UPDATE = 1;
        internal const uint CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO = 2;
        internal const uint CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH = 4;
        internal const uint CF_CALLBACK_DELETE_FLAG_IS_DIRECTORY = 1;

        /// <summary>CF_PROCESS_INFO is { DWORD StructSize; DWORD ProcessId; … }.</summary>
        internal const int CF_PROCESS_INFO_PROCESS_ID_OFFSET = 4;
        /// <summary>The callback parameter union starts after ULONG ParamSize + padding.</summary>
        internal const int CF_CALLBACK_PARAMETERS_FLAGS_OFFSET = 8;

        // --- CF_OPERATION_TYPE ---
        internal const int CF_OPERATION_TYPE_TRANSFER_DATA = 0;
        internal const int CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS = 4;
        internal const int CF_OPERATION_TYPE_ACK_DELETE = 6;
        internal const int CF_OPERATION_TYPE_ACK_RENAME = 7;

        internal const uint CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION = 2;

        // --- placeholder create flags ---
        internal const uint CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION = 1;
        internal const uint CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC = 2;

        // --- CF_PLACEHOLDER_STATE (cfapi.h) ---
        internal const uint CF_PLACEHOLDER_STATE_PLACEHOLDER = 1;
        internal const uint CF_PLACEHOLDER_STATE_IN_SYNC = 8;
        internal const uint CF_PLACEHOLDER_STATE_PARTIAL = 0x10;
        internal const uint CF_PLACEHOLDER_STATE_INVALID = 0xFFFFFFFF;
        internal const uint CF_OPEN_FILE_FLAG_NONE = 0;
        internal const uint CF_OPEN_FILE_FLAG_EXCLUSIVE = 1;
        internal const uint CF_UPDATE_FLAG_VERIFY_IN_SYNC = 1;
        internal const uint CF_UPDATE_FLAG_MARK_IN_SYNC = 2;
        internal const uint CF_UPDATE_FLAG_DEHYDRATE = 4;
        internal const uint CF_UPDATE_FLAG_ENABLE_ON_DEMAND_POPULATION = 0x08;
        internal const int CF_PLACEHOLDER_INFO_BASIC = 0;
        internal const uint CF_PIN_STATE_PINNED = 1;
        internal const uint CF_IN_SYNC_STATE_IN_SYNC = 1;

        // --- CF_SYNC_ROOT_INFO_CLASS / CF_SYNC_ROOT_PROVIDER_INFO ---
        // { CF_SYNC_PROVIDER_STATUS ProviderStatus; WCHAR ProviderName[256];
        //   WCHAR ProviderVersion[256]; }
        internal const int CF_SYNC_ROOT_INFO_PROVIDER = 2;
        internal const int CF_SYNC_ROOT_PROVIDER_INFO_NAME_OFFSET = 4;
        internal const int CF_SYNC_ROOT_PROVIDER_INFO_NAME_BYTES = 256 * 2;
        internal const int CF_SYNC_ROOT_PROVIDER_INFO_SIZE = 4 + 256 * 2 + 256 * 2;

        internal const int STATUS_SUCCESS = 0;
        internal const int STATUS_UNSUCCESSFUL = unchecked((int)0xC0000001);
        internal const int STATUS_CLOUD_FILE_ACCESS_DENIED = unchecked((int)0xC000CF18);

        /// <summary>Both served callbacks and the ranges CfExecute buffers
        /// must land on this boundary (except at end of file).</summary>
        internal const int HydrationChunkAlignment = 4096;

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_SYNC_REGISTRATION
        {
            public uint StructSize;
            public IntPtr ProviderName;       // PCWSTR
            public IntPtr ProviderVersion;    // PCWSTR
            public IntPtr SyncRootIdentity;
            public uint SyncRootIdentityLength;
            public IntPtr FileIdentity;
            public uint FileIdentityLength;
            public Guid ProviderId;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_SYNC_POLICIES
        {
            public uint StructSize;
            public ushort HydrationPrimary;
            public ushort HydrationModifier;
            public ushort PopulationPrimary;
            public ushort PopulationModifier;
            public uint InSync;
            public uint HardLink;
            public uint PlaceholderManagement;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_CALLBACK_REGISTRATION
        {
            public int Type;
            public IntPtr Callback;
        }

        /// <summary>void CALLBACK(const CF_CALLBACK_INFO*, const
        /// CF_CALLBACK_PARAMETERS*). Both sides read via pointer so a layout
        /// mistake in one struct can't corrupt the other's fields.</summary>
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        internal delegate void CfCallback(IntPtr callbackInfo, IntPtr callbackParameters);

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_CALLBACK_INFO
        {
            public uint StructSize;
            public long ConnectionKey;
            public IntPtr CallbackContext;
            public IntPtr VolumeGuidName;     // PCWSTR
            public IntPtr VolumeDosName;      // PCWSTR
            public uint VolumeSerialNumber;
            public long SyncRootFileId;
            public IntPtr SyncRootIdentity;
            public uint SyncRootIdentityLength;
            public long FileId;
            public long FileSize;
            public IntPtr FileIdentity;
            public uint FileIdentityLength;
            public IntPtr NormalizedPath;     // PCWSTR
            public long TransferKey;
            public byte PriorityHint;
            public IntPtr CorrelationVector;
            public IntPtr ProcessInfo;
            public long RequestKey;
        }

        /// <summary>The FetchData variant of CF_CALLBACK_PARAMETERS. Union
        /// content starts at offset 8 (after ULONG ParamSize + padding).</summary>
        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_CALLBACK_PARAMETERS_FETCH_DATA
        {
            public uint ParamSize;
            private uint _pad;
            public uint Flags;
            private uint _pad2;
            public long RequiredFileOffset;
            public long RequiredLength;
            public long OptionalFileOffset;
            public long OptionalLength;
            public long LastDehydrationTime;
            public int LastDehydrationReason;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_CALLBACK_PARAMETERS_NOTIFY
        {
            public uint ParamSize;
            private uint _pad;
            public uint Flags;
            private uint _pad2;
            public IntPtr TargetPath;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_OPERATION_INFO
        {
            public uint StructSize;
            public int Type;
            public long ConnectionKey;
            public long TransferKey;
            public IntPtr CorrelationVector;
            public IntPtr SyncStatus;
            public long RequestKey;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_OPERATION_PARAMETERS_TRANSFER_DATA
        {
            public uint ParamSize;
            private uint _pad;
            public uint Flags;
            public int CompletionStatus;      // NTSTATUS
            public IntPtr Buffer;
            public long Offset;
            public long Length;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_OPERATION_PARAMETERS_TRANSFER_PLACEHOLDERS
        {
            public uint ParamSize;
            private uint _pad;
            public uint Flags;
            public int CompletionStatus;      // NTSTATUS
            public long PlaceholderTotalCount;
            public IntPtr PlaceholderArray;   // CF_PLACEHOLDER_CREATE_INFO*
            public uint PlaceholderCount;
            public uint EntriesProcessed;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_OPERATION_PARAMETERS_ACK
        {
            public uint ParamSize;
            private uint _pad;
            public uint Flags;
            public int CompletionStatus;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct FILE_BASIC_INFO
        {
            public long CreationTime;
            public long LastAccessTime;
            public long LastWriteTime;
            public long ChangeTime;
            public uint FileAttributes;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_FS_METADATA
        {
            public FILE_BASIC_INFO BasicInfo;
            public long FileSize;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_PLACEHOLDER_BASIC_INFO
        {
            public uint PinState;
            public uint InSyncState;
            public long FileId;
            public long SyncRootFileId;
            public uint FileIdentityLength;
            public byte FileIdentity;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        internal struct CF_PLACEHOLDER_CREATE_INFO
        {
            public IntPtr RelativeFileName;   // PCWSTR
            public CF_FS_METADATA FsMetadata;
            public IntPtr FileIdentity;
            public uint FileIdentityLength;
            public uint Flags;
            public int Result;                // HRESULT, out
            public long CreateUsn;            // out
        }

        [DllImport(Dll, CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int CfRegisterSyncRoot(
            string syncRootPath,
            ref CF_SYNC_REGISTRATION registration,
            ref CF_SYNC_POLICIES policies,
            uint registerFlags);

        [DllImport(Dll, CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int CfUnregisterSyncRoot(string syncRootPath);

        /// <summary>Returns S_OK only when the path lies inside a registered
        /// sync root; the buffer layout follows <paramref name="infoClass"/>.</summary>
        [DllImport(Dll, CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int CfGetSyncRootInfoByPath(
            string filePath,
            int infoClass,
            [Out] byte[] infoBuffer,
            uint infoBufferLength,
            out uint returnedLength);

        [DllImport(Dll, ExactSpelling = true)]
        internal static extern uint CfGetPlaceholderStateFromAttributeTag(uint fileAttributes, uint reparseTag);

        [DllImport(Dll, CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int CfOpenFileWithOplock(string filePath, uint flags, out IntPtr protectedHandle);

        [DllImport(Dll, ExactSpelling = true)]
        internal static extern void CfCloseHandle(IntPtr protectedHandle);

        [DllImport(Dll, ExactSpelling = true)]
        internal static extern int CfGetPlaceholderInfo(
            Microsoft.Win32.SafeHandles.SafeFileHandle fileHandle, int infoClass,
            IntPtr infoBuffer, uint infoBufferLength, out uint returnedLength);

        [DllImport(Dll, ExactSpelling = true)]
        internal static extern int CfUpdatePlaceholder(
            IntPtr fileHandle, IntPtr fsMetadata, IntPtr fileIdentity, uint fileIdentityLength,
            IntPtr dehydrateRangeArray, uint dehydrateRangeCount, uint updateFlags,
            IntPtr updateUsn, IntPtr overlapped);

        [DllImport(Dll, CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int CfCreatePlaceholders(
            string baseDirectoryPath, [In, Out] CF_PLACEHOLDER_CREATE_INFO[] placeholderArray,
            uint placeholderCount, uint createFlags, out uint entriesProcessed);

        [DllImport(Dll, CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int CfConnectSyncRoot(
            string syncRootPath,
            [In] CF_CALLBACK_REGISTRATION[] callbackTable,
            IntPtr callbackContext,
            uint connectFlags,
            out long connectionKey);

        [DllImport(Dll, ExactSpelling = true)]
        internal static extern int CfDisconnectSyncRoot(long connectionKey);

        [DllImport(Dll, EntryPoint = "CfExecute", ExactSpelling = true)]
        internal static extern int CfExecuteTransferData(
            ref CF_OPERATION_INFO opInfo,
            ref CF_OPERATION_PARAMETERS_TRANSFER_DATA opParams);

        [DllImport(Dll, EntryPoint = "CfExecute", ExactSpelling = true)]
        internal static extern int CfExecuteTransferPlaceholders(
            ref CF_OPERATION_INFO opInfo,
            ref CF_OPERATION_PARAMETERS_TRANSFER_PLACEHOLDERS opParams);

        [DllImport(Dll, EntryPoint = "CfExecute", ExactSpelling = true)]
        internal static extern int CfExecuteAck(ref CF_OPERATION_INFO opInfo, ref CF_OPERATION_PARAMETERS_ACK opParams);
    }
}
