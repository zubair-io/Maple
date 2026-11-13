# Download the original archive, never an export or a second compilation (#5681).
require 'openssl'
require 'json'
require 'base64'
require 'net/http'

class CloudArchive
  class TransientDownloadError < StandardError; end
  API = 'https://api.appstoreconnect.apple.com/v1/'
  RELEASE_WORKFLOW = 'd0c1c449-cedd-437f-a105-acb637b109cf'

  def initialize(key_path, key_id, issuer)
    @credentials = [key_path, key_id, issuer]
    @expires_at = Time.now.to_i + 1200
    encode = ->(value) { Base64.urlsafe_encode64(value, padding: false) }
    header = encode.call({ alg: 'ES256', kid: key_id, typ: 'JWT' }.to_json)
    payload = encode.call({ iss: issuer, iat: Time.now.to_i,
                            exp: @expires_at, aud: 'appstoreconnect-v1' }.to_json)
    input = "#{header}.#{payload}"
    key = OpenSSL::PKey.read(File.read(key_path))
    signature = OpenSSL::ASN1.decode(key.sign('SHA256', input)).value.map do |part|
      part.value.to_s(2).rjust(32, "\0")
    end.join
    @token = "#{input}.#{encode.call(signature)}"
  end

  def read(path)
    initialize(*@credentials) if Time.now.to_i >= @expires_at - 60
    uri = URI(API + path)
    request = Net::HTTP::Get.new(uri)
    request['Authorization'] = "Bearer #{@token}"
    response = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(request) }
    abort "App Store Connect request failed (HTTP #{response.code})" unless response.is_a?(Net::HTTPSuccess)
    JSON.parse(response.body).fetch('data')
  end

  def self.release_build(builds, expected_commit)
    builds.select do |build|
      attributes = build.fetch('attributes')
      !attributes['isPullRequestBuild'] && attributes.dig('sourceCommit', 'commitSha') == expected_commit
    end.max_by { |build| build.fetch('attributes').fetch('createdDate') }
  end

  def wait_for_archive(expected_commit)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 3600
    loop do
      builds = read("ciWorkflows/#{RELEASE_WORKFLOW}/buildRuns?limit=200")
      build = self.class.release_build(builds, expected_commit)
      if build && build.fetch('attributes')['executionProgress'] == 'COMPLETE'
        puts "Using Xcode Cloud build #{build.fetch('attributes').fetch('number')} for the release commit."
        return archive(build.fetch('id'), expected_commit)
      end
      raise 'Timed out waiting for the release archive in Xcode Cloud' if
        Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
      puts 'Waiting for Xcode Cloud to finish the production archive...'
      $stdout.flush
      sleep 30
    end
  end

  def self.validate_build(build, expected_commit)
    attributes = build.fetch('attributes')
    raise 'Cloud build source does not match the release tag' unless
      attributes.fetch('sourceCommit').fetch('commitSha') == expected_commit
    raise 'Wait for the cloud build to finish before recovering it' unless
      attributes.fetch('executionProgress') == 'COMPLETE'
  end

  def archive(build_id, expected_commit)
    raise 'Invalid build UUID' unless build_id.match?(/\A[0-9a-f-]{36}\z/)
    self.class.validate_build(read("ciBuildRuns/#{build_id}"), expected_commit)
    actions = read("ciBuildRuns/#{build_id}/actions?limit=200")
    mac = actions.select do |action|
      action.fetch('attributes').values_at('name', 'actionType') == ['Archive - macOS', 'ARCHIVE']
    end
    raise 'Expected exactly one macOS archive action' unless mac.length == 1
    artifacts = read("ciBuildActions/#{mac.first.fetch('id')}/artifacts?limit=200")
    archives = artifacts.select { |artifact| artifact.fetch('attributes')['fileType'] == 'ARCHIVE' }
    raise 'Expected exactly one original macOS archive' unless archives.length == 1
    archives.first.fetch('attributes')
  end

  def self.download(url, output)
    attempt = 0
    begin
      attempt += 1
      download_once(url, output, 5)
    rescue TransientDownloadError, Net::ReadTimeout, Net::OpenTimeout, EOFError, Errno::ECONNRESET
      raise if attempt >= 6
      puts "Apple artifact download is temporarily unavailable; retrying (#{attempt}/5)."
      sleep [5 * (2**(attempt - 1)), 60].min
      retry
    end
  end

  def self.download_once(url, output, redirects)
    uri = URI(url)
    raise 'Artifact download must use HTTPS' unless uri.scheme == 'https'
    # Signed artifact URLs carry their own authorization. Never forward the API JWT.
    Net::HTTP.start(uri.host, uri.port, use_ssl: true, read_timeout: 120) do |http|
      http.request_get(uri.request_uri) do |response|
        if response.is_a?(Net::HTTPRedirection) && redirects.positive?
          return download_once(URI.join(url, response.fetch('location')).to_s, output, redirects - 1)
        end
        raise TransientDownloadError, "Artifact service returned HTTP #{response.code}" if
          response.code == '429' || response.code.to_i >= 500
        raise "Artifact download failed (HTTP #{response.code})" unless response.is_a?(Net::HTTPSuccess)
        File.open(output, 'wb') { |file| response.read_body { |chunk| file.write(chunk) } }
      end
    end
  end
end

if $PROGRAM_NAME == __FILE__
  client = CloudArchive.new(ENV.fetch('AC_KEY_PATH'), ENV.fetch('AC_KEY_ID'), ENV.fetch('AC_ISSUER_ID'))
  build_id = ENV.fetch('CLOUD_BUILD_ID', '')
  artifact = if build_id.empty?
               client.wait_for_archive(ENV.fetch('EXPECTED_COMMIT'))
             else
               client.archive(build_id, ENV.fetch('EXPECTED_COMMIT'))
             end
  output = ARGV.fetch(0)
  CloudArchive.download(artifact.fetch('downloadUrl'), output)
  raise 'Downloaded archive size differs from Apple metadata' unless File.size(output) == artifact.fetch('fileSize')
  puts 'Downloaded the original macOS archive for the verified release commit.'
end
