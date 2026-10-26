import Foundation

extension MapleSidecarPaths {
  /// Removes the derivative and its legacy name, so a stale legacy file can
  /// never be adopted for a different asset that later takes this name.
  public static func removeDerivative(
    at derivativeURL: URL, legacy: URL, fileManager fm: FileManager = .default
  ) {
    LocalDerivativeSourceStamp.remove(derivativeURL)
    try? fm.removeItem(at: derivativeURL)
    try? fm.removeItem(at: legacy)
  }
}
