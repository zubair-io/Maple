using System;
using System.Net.Http;
using System.Threading.Tasks;

namespace Maple.WinUI.Services
{
    public class CloudSyncAgent
    {
        private readonly HttpClient _httpClient;
        public string ServerUrl { get; set; } = "http://localhost:3000";

        public CloudSyncAgent()
        {
            _httpClient = new HttpClient();
        }

        public async Task<bool> CheckServerHealthAsync()
        {
            try
            {
                var response = await _httpClient.GetAsync($"{ServerUrl.TrimEnd('/')}/health");
                return response.IsSuccessStatusCode;
            }
            catch
            {
                return false;
            }
        }

        public async Task<bool> SyncSidecarAsync(string relativePath, string xmpData)
        {
            try
            {
                var content = new StringContent(xmpData, System.Text.Encoding.UTF8, "application/xml");
                var response = await _httpClient.PostAsync($"{ServerUrl.TrimEnd('/')}/api/sidecars/sync?path={Uri.EscapeDataString(relativePath)}", content);
                return response.IsSuccessStatusCode;
            }
            catch
            {
                return false;
            }
        }
    }
}
