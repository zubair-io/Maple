import Foundation
import GRDB

/// iOS kills a process suspended while it holds a file lock in an App Group
/// container (0xDEAD10CC, #5652). A suspended store refuses work and drops its lock;
/// a refused write throws and leaves the row for rehydrate.
public enum BackupStateSuspension {
  public static func suspend() {
    NotificationCenter.default.post(name: Database.suspendNotification, object: nil)
  }

  public static func resume() {
    NotificationCenter.default.post(name: Database.resumeNotification, object: nil)
  }
}
