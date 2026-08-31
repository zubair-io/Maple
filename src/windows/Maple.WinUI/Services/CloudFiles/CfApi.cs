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
        internal const int CF_CALLBACK_TYPE_NONE = unchecked((int)0xFFFFFFFF);

        // --- policies ---
        internal const ushort CF_HYDRATION_POLICY_FULL = 2;
        internal const ushort CF_POPULATION_POLICY_PARTIAL = 0;
        internal const uint CF_INSYNC_POLICY_NONE = 0;
        internal const uint CF_HARDLINK_POLICY_NONE = 0;

        internal const uint CF_REGISTER_FLAG_UPDATE = 1;
        internal const uint CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH = 2;

        // --- CF_OPERATION_TYPE ---
        internal const int CF_OPERATION_TYPE_TRANSFER_DATA = 0;
        internal const int CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS = 4;

        internal const uint CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION = 2;

        // --- placeholder create flags ---
        internal const uint CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION = 1;
        internal const uint CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC = 2;

        internal const int STATUS_SUCCESS = 0;
        internal const int STATUS_UNSUCCESSFUL = unchecked((int)0xC0000001);

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
    }
}
