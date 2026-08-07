// FileOperationException.cs — typed errors for the local file-operations
// service (relocate / trash / folder CRUD), issue #2632. Every case is a
// distinct, UI-explainable failure — never a generic "something went wrong."
// Mirrors Apple's `FileOperationError` (`src/apple/Packages/MapleCore/
// Sources/MapleCore/FileOperations/FileOperationError.swift`) case-for-case
// so the same failure surfaces the same way in the UI regardless of
// platform.

using System;

namespace Maple.WinUI.Services.FileOperations
{
    public enum FileOperationErrorKind
    {
        /// <summary>The operation is routed elsewhere entirely — a Cloud
        /// source goes through the Self Hosted API, not this local
        /// module (see the design doc's "Platform routing" table).</summary>
        UnsupportedSource,

        /// <summary>The primary file (or folder) was gone by the time this
        /// module tried to read it — vanished between the caller's snapshot
        /// and this call.</summary>
        SourceMissing,

        /// <summary>A copy completed but its destination didn't match the
        /// source (size/mtime mismatch). The partial copy is removed before
        /// this is thrown; the source is always left untouched.</summary>
        VerificationFailed,

        /// <summary><see cref="CollisionPolicy.Fail"/> was requested and the
        /// destination already existed.</summary>
        DestinationExists,

        /// <summary>The destination is invalid for this operation — outside
        /// the library root, or (for a folder move) inside the folder's own
        /// subtree.</summary>
        InvalidDestination,

        /// <summary>The destination names the SAME on-disk file as the
        /// source. Refused before any remove/copy runs — see
        /// <see cref="LocalFileOperations.ClassifySameFile"/>. Does NOT fire
        /// for a case-only rename on NTFS (case-insensitive-but-case-
        /// preserving, like APFS) — that's a legitimate rename, handled as a
        /// direct atomic move instead.</summary>
        SameFile,

        /// <summary>A lower-level System.IO error, wrapped with
        /// context.</summary>
        Underlying,
    }

    public sealed class FileOperationException : Exception
    {
        public FileOperationErrorKind Kind { get; }

        public FileOperationException(FileOperationErrorKind kind, string detail)
            : base(Describe(kind, detail))
        {
            Kind = kind;
        }

        public FileOperationException(FileOperationErrorKind kind, string detail, Exception innerException)
            : base(Describe(kind, detail), innerException)
        {
            Kind = kind;
        }

        private static string Describe(FileOperationErrorKind kind, string detail) => kind switch
        {
            FileOperationErrorKind.UnsupportedSource => $"Not supported for this source: {detail}",
            FileOperationErrorKind.SourceMissing => $"File no longer exists: {detail}",
            FileOperationErrorKind.VerificationFailed => $"Copy verification failed: {detail}",
            FileOperationErrorKind.DestinationExists => $"Destination already exists: {detail}",
            FileOperationErrorKind.InvalidDestination => $"Invalid destination: {detail}",
            FileOperationErrorKind.SameFile => $"Source and destination are the same file: {detail}",
            FileOperationErrorKind.Underlying => detail,
            _ => detail,
        };

        /// <summary>Cloud (Self Hosted) sources route file operations through
        /// the API, not this on-device module. A caller that reaches this
        /// module with a Cloud asset has mis-routed; this makes that mistake
        /// loud rather than attempting a meaningless local filesystem
        /// operation.</summary>
        public static FileOperationException CloudRoutesThroughApi(string operation) =>
            new(FileOperationErrorKind.UnsupportedSource,
                $"Cloud: {operation} must go through the Self Hosted API, not the local file-operations module");
    }
}
