// src/apple/MapleFileProviderIOS/FileProviderExtensionIOS.swift
import FileProvider
import MapleCore

/// Platform entry-point for the iOS / iPadOS File Provider extension. All
/// behaviour lives in `MapleCore.FileProviderExtensionCore`; this class
/// exists because `NSExtensionPrincipalClass` must name a class inside
/// *this* target's module.
final class FileProviderExtensionIOS: FileProviderExtensionCore {}
