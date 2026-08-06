using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Maple.WinUI.Services
{
    public class CloudSyncAgent
    {
        private readonly HttpClient _httpClient;
        public string ServerUrl { get; set; } = "http://localhost:3000";

        public CloudSyncAgent()
        {
            _httpClient = new HttpClient
            {
                Timeout = TimeSpan.FromSeconds(15)
            };
        }

        public async Task<bool> CheckServerHealthAsync()
        {
            try
            {
                var response = await _httpClient.GetAsync($"{ServerUrl.TrimEnd('/')}/health");
                return response.IsSuccessStatusCode;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[CloudSyncAgent] Health check failed: {ex.Message}");
                return false;
            }
        }

        public async Task<bool> SyncSidecarAsync(string relativePath, string xmpData)
        {
            if (string.IsNullOrWhiteSpace(relativePath) || string.IsNullOrWhiteSpace(xmpData))
                throw new ArgumentException("Relative path and XMP payload must be non-empty.");

            try
            {
                var content = new StringContent(xmpData, Encoding.UTF8, "application/xml");
                var response = await _httpClient.PostAsync($"{ServerUrl.TrimEnd('/')}/api/sidecars/sync?path={Uri.EscapeDataString(relativePath)}", content);
                return response.IsSuccessStatusCode;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[CloudSyncAgent] Sidecar sync failed for {relativePath}: {ex.Message}");
                return false;
            }
        }

        public async Task<bool> SyncCatalogAsync(string catalogId, object catalogManifest)
        {
            if (string.IsNullOrWhiteSpace(catalogId))
                throw new ArgumentNullException(nameof(catalogId));

            try
            {
                string json = JsonSerializer.Serialize(catalogManifest);
                var content = new StringContent(json, Encoding.UTF8, "application/json");
                var response = await _httpClient.PostAsync($"{ServerUrl.TrimEnd('/')}/api/backup/catalog?id={Uri.EscapeDataString(catalogId)}", content);
                return response.IsSuccessStatusCode;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[CloudSyncAgent] Catalog sync error: {ex.Message}");
                return false;
            }
        }
    }
}
