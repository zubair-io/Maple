require 'minitest/autorun'
require_relative 'download-cloud-archive'

class CloudArchiveTest < Minitest::Test
  SHA = 'a' * 40
  ID = '12345678-1234-1234-1234-123456789abc'

  def build(sha = SHA, progress = 'COMPLETE')
    { 'attributes' => { 'sourceCommit' => { 'commitSha' => sha }, 'executionProgress' => progress } }
  end

  def test_failed_distribution_can_reuse_completed_archive
    record = build
    record['attributes']['completionStatus'] = 'FAILED'
    CloudArchive.validate_build(record, SHA)
  end

  def test_wrong_release_commit_is_rejected
    assert_raises(RuntimeError) { CloudArchive.validate_build(build('b' * 40), SHA) }
  end

  def test_running_build_is_rejected
    assert_raises(RuntimeError) { CloudArchive.validate_build(build(SHA, 'RUNNING'), SHA) }
  end

  def client(artifacts)
    data = {
      "ciBuildRuns/#{ID}" => build,
      "ciBuildRuns/#{ID}/actions?limit=200" => [
        { 'id' => 'ios', 'attributes' => { 'name' => 'Archive - iOS', 'actionType' => 'ARCHIVE' } },
        { 'id' => 'mac', 'attributes' => { 'name' => 'Archive - macOS', 'actionType' => 'ARCHIVE' } }
      ],
      'ciBuildActions/mac/artifacts?limit=200' => artifacts
    }
    result = CloudArchive.allocate
    result.define_singleton_method(:read) { |path| data.fetch(path) }
    result
  end

  def test_selects_original_archive_and_never_an_export
    artifacts = %w[ARCHIVE_EXPORT ARCHIVE LOG_BUNDLE].map { |type| { 'attributes' => { 'fileType' => type } } }
    assert_equal 'ARCHIVE', client(artifacts).archive(ID, SHA)['fileType']
  end

  def test_missing_or_ambiguous_archives_are_rejected
    [[], [{ 'attributes' => { 'fileType' => 'ARCHIVE' } }] * 2].each do |artifacts|
      assert_raises(RuntimeError) { client(artifacts).archive(ID, SHA) }
    end
  end

  def test_download_refuses_plaintext_transport
    assert_raises(RuntimeError) { CloudArchive.download('http://example.com/archive', '/unused') }
  end
end
