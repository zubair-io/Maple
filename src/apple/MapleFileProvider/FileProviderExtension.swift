// src/apple/MapleFileProvider/FileProviderExtension.swift
import FileProvider
import MapleCore

/// Platform entry-point for the macOS File Provider extension. All behaviour
/// lives in `MapleCore.FileProviderExtensionCore`; this class exists because
/// `NSExtensionPrincipalClass` must name a class inside *this* target's module.
final class FileProviderExtension: FileProviderExtensionCore {}
