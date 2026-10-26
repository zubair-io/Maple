// src/apple/MapleFileProvider/FileProviderExtension.swift
import FileProvider
import MapleFileProviderCore

/// Platform entry-point for the macOS File Provider extension. All behaviour
/// lives in `MapleFileProviderCore.FileProviderExtensionCore`; this class exists because
/// `NSExtensionPrincipalClass` must name a class inside *this* target's module.
final class FileProviderExtension: FileProviderExtensionCore {}
