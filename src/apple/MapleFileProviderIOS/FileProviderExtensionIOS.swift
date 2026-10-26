// src/apple/MapleFileProviderIOS/FileProviderExtensionIOS.swift
import FileProvider
import MapleFileProviderCore

/// Platform entry-point for the iOS / iPadOS File Provider extension. All
/// behaviour lives in `MapleFileProviderCore.FileProviderExtensionCore`; this class
/// exists because `NSExtensionPrincipalClass` must name a class inside
/// *this* target's module.
final class FileProviderExtensionIOS: FileProviderExtensionCore {}
