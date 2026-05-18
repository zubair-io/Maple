#!/usr/bin/env ruby
# src/apple/scripts/remove-from-macos-fileprovider-target.rb
#
# One-shot edit: drop the FP sources whose bodies now live inside
# MapleCore from the macOS MapleFileProvider extension target. After
# this script runs, those sources are compiled inside the MapleCore SPM
# module instead (Phase 4 Task 1 promoted them there). The macOS target
# retains a thin `FileProviderExtension.swift` subclass entry-point so
# the bundle still exports the principal class.
#
# Usage:
#   cd src/apple && ruby scripts/remove-from-macos-fileprovider-target.rb
#
# Idempotent: re-running once the files are already removed is a no-op.

require "xcodeproj"

PROJECT_PATH = File.expand_path("../Maple.xcodeproj", __dir__)
TARGET_NAME  = "MapleFileProvider"
DOOMED_NAMES = [
  "MapleItem.swift",
  "MapleEnumerator.swift",
  "ChangeFeedClient.swift",
  "WorkingSetEnumerator.swift",
]

project = Xcodeproj::Project.open(PROJECT_PATH)
target = project.targets.find { |t| t.name == TARGET_NAME } \
  or abort "[remove-from-macos-fp-target] #{TARGET_NAME} target not found"

removed_any = false

# 1. Drop from the target's Sources build phase. remove_build_file also
#    deletes the PBXBuildFile object.
target.source_build_phase.files.dup.each do |bf|
  name = bf.file_ref&.path
  next unless DOOMED_NAMES.include?(name)
  target.source_build_phase.remove_build_file(bf)
  removed_any = true
end

# 2. Delete the PBXFileReference itself + remove from its parent group.
project.files.dup.each do |f|
  next unless DOOMED_NAMES.include?(f.path)
  f.remove_from_project
  removed_any = true
end

project.save
if removed_any
  puts "[remove-from-macos-fp-target] removed: #{DOOMED_NAMES.join(', ')}"
else
  puts "[remove-from-macos-fp-target] nothing to remove."
end
