import Foundation

/// Apple Live Photo pairing for sources that list plain files: local folders and SMB shares.
/// The same rule the Self Hosted indexer applies (`library/live-photo-pairs.ts`, #5448): a still
/// and a clip pair only when they sit in the same folder, share a case-folded stem AND carry the
/// same Apple content identifier. The stem only nominates candidates, because `IMG_1234` repeats
/// across cameras and imports. A file with no identifier, or a stem-and-identifier group that is
/// not exactly one still and one clip, stays unpaired.
public enum LivePhotoPairing {
  public enum Kind: Sendable, Hashable {
    case still
    case clip

    init?(filename: String) {
      switch (filename as NSString).pathExtension.lowercased() {
      case "jpg", "jpeg", "heic", "heif": self = .still
      case "mov": self = .clip
      default: return nil
      }
    }
  }

  /// One listed file: where it is and the identifier read from it, if it carries one.
  public struct Candidate: Sendable, Hashable {
    public let path: String
    public let contentID: String?

    public init(path: String, contentID: String?) {
      self.path = path
      self.contentID = contentID
    }
  }

  /// Files read for an identifier at once.
  static let readConcurrency = 4

  /// The pairs among `candidates`, keyed by path: both halves of each pair map to their link.
  public static func pair(_ candidates: [Candidate]) -> [String: LivePhotoLink] {
    let members = candidates.compactMap { candidate -> Member? in
      let name = (candidate.path as NSString).lastPathComponent
      guard let kind = Kind(filename: name), let contentID = candidate.contentID,
        !contentID.isEmpty
      else { return nil }
      return Member(
        path: candidate.path, name: name, kind: kind, key: key(candidate.path, contentID))
    }
    let pairs = Dictionary(grouping: members, by: \.key).values.compactMap {
      group -> (Member, Member)? in
      let stills = group.filter { $0.kind == .still }
      let clips = group.filter { $0.kind == .clip }
      guard stills.count == 1, clips.count == 1 else { return nil }
      return (stills[0], clips[0])
    }
    return Dictionary(
      uniqueKeysWithValues: pairs.flatMap { still, clip in
        [
          (still.path, LivePhotoLink(role: .still, partner: clip.name)),
          (clip.path, LivePhotoLink(role: .clip, partner: still.name)),
        ]
      })
  }

  /// The pairs among the files at `paths`. Only paths whose folder and stem hold both a still and
  /// a clip are read for an identifier, so a library without Live Photos costs no reads.
  /// `contentID` reads one file's identifier; a nil result leaves that file unpaired.
  public static func links(
    for paths: [String], contentID: @escaping @Sendable (String) async -> String?
  ) async -> [String: LivePhotoLink] {
    let nominated = nominatedPaths(in: paths)
    guard !nominated.isEmpty else { return [:] }
    let candidates = await withTaskGroup(of: Candidate.self) { group in
      var iterator = nominated.makeIterator()
      var found: [Candidate] = []
      func addNext() {
        guard let path = iterator.next() else { return }
        group.addTask { Candidate(path: path, contentID: await contentID(path)) }
      }
      for _ in 0..<min(readConcurrency, nominated.count) { addNext() }
      while let candidate = await group.next() {
        found.append(candidate)
        addNext()
      }
      return found
    }
    return pair(candidates)
  }

  private struct Member {
    let path: String
    let name: String
    let kind: Kind
    let key: String
  }

  private static func key(_ path: String, _ contentID: String) -> String {
    let folder = (path as NSString).deletingLastPathComponent
    return "\(folder)\0\(stem(of: path))\0\(contentID)"
  }

  private static func stem(of path: String) -> String {
    ((path as NSString).lastPathComponent as NSString).deletingPathExtension.lowercased()
  }

  private static func nominatedPaths(in paths: [String]) -> [String] {
    let groups = Dictionary(
      grouping: paths.filter { Kind(filename: ($0 as NSString).lastPathComponent) != nil }
    ) {
      "\(($0 as NSString).deletingLastPathComponent)\0\(stem(of: $0))"
    }
    return groups.values.filter { group in
      let kinds = Set(group.compactMap { Kind(filename: ($0 as NSString).lastPathComponent) })
      return kinds.count == 2
    }.flatMap { $0 }.sorted()
  }
}
