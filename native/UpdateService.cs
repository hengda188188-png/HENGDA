using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

namespace PhotoRelayNative;

internal sealed record UpdateInfo(Version Version, string Tag, string Notes, string ZipUrl, string HashUrl);

internal sealed class UpdateService : IDisposable
{
    public const string Repository = "hengda188188-png/HENGDA";
    public const string ZipAsset = "PhotoRelay-portable-win-x64.zip";
    public const string HashAsset = "PhotoRelay-portable-win-x64.zip.sha256";
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromMinutes(10) };

    public UpdateService()
    {
        http.DefaultRequestHeaders.UserAgent.ParseAdd("PhotoRelay-Updater/0.3");
        http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
    }

    public Version CurrentVersion => Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0, 0);

    public async Task<UpdateInfo?> CheckAsync(CancellationToken cancellationToken = default)
    {
        using var response = await http.GetAsync($"https://api.github.com/repos/{Repository}/releases/latest", cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellationToken));
        var root = document.RootElement;
        var tag = root.GetProperty("tag_name").GetString() ?? "";
        if (!Version.TryParse(tag.TrimStart('v', 'V'), out var version)) return null;
        string? zipUrl = null, hashUrl = null;
        foreach (var asset in root.GetProperty("assets").EnumerateArray())
        {
            var name = asset.GetProperty("name").GetString();
            var url = asset.GetProperty("browser_download_url").GetString();
            if (name == ZipAsset) zipUrl = url;
            if (name == HashAsset) hashUrl = url;
        }
        if (version <= CurrentVersion || zipUrl is null || hashUrl is null) return null;
        return new UpdateInfo(version, tag, root.GetProperty("body").GetString() ?? "", zipUrl, hashUrl);
    }

    public async Task<string> DownloadAndVerifyAsync(UpdateInfo update, IProgress<int>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var root = Path.Combine(Path.GetTempPath(), "PhotoRelay-update-" + Guid.NewGuid().ToString("N"));
        var zip = Path.Combine(root, ZipAsset);
        var staging = Path.Combine(root, "staging");
        Directory.CreateDirectory(root);
        var expected = (await http.GetStringAsync(update.HashUrl, cancellationToken)).Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)[0];
        using (var response = await http.GetAsync(update.ZipUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken))
        {
            response.EnsureSuccessStatusCode();
            var total = response.Content.Headers.ContentLength;
            await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
            await using var output = File.Create(zip);
            var buffer = new byte[128 * 1024];
            long received = 0;
            int read;
            while ((read = await input.ReadAsync(buffer, cancellationToken)) > 0)
            {
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                received += read;
                if (total > 0) progress?.Report((int)(received * 100 / total.Value));
            }
        }
        var actual = Convert.ToHexString(await SHA256.HashDataAsync(File.OpenRead(zip), cancellationToken));
        if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("更新包 SHA-256 驗證失敗，已取消安裝。");
        ZipFile.ExtractToDirectory(zip, staging);
        if (!File.Exists(Path.Combine(staging, "PhotoRelay.exe")) ||
            !File.Exists(Path.Combine(staging, "app", "server.mjs")) ||
            !File.Exists(Path.Combine(staging, "runtime", "node.exe")))
            throw new InvalidDataException("更新包結構不完整，已取消安裝。");
        return staging;
    }

    public void LaunchInstaller(string stagingDirectory)
    {
        var target = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        var backup = Path.Combine(Path.GetTempPath(), "PhotoRelay-backup-" + DateTime.Now.ToString("yyyyMMddHHmmss"));
        var script = Path.Combine(Path.GetTempPath(), "PhotoRelay-apply-" + Guid.NewGuid().ToString("N") + ".ps1");
        var body = """
param([int]$PidToWait,[string]$Source,[string]$Target,[string]$Backup)
$ErrorActionPreference='Stop'
try {
  Wait-Process -Id $PidToWait -Timeout 30 -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $Backup -Force | Out-Null
  foreach($name in @('PhotoRelay.exe','app','runtime','QUICK-START.txt')) {
    $old=Join-Path $Target $name
    if(Test-Path -LiteralPath $old){Move-Item -LiteralPath $old -Destination $Backup -Force}
  }
  foreach($item in Get-ChildItem -LiteralPath $Source -Force){Copy-Item -LiteralPath $item.FullName -Destination $Target -Recurse -Force}
  Start-Process -FilePath (Join-Path $Target 'PhotoRelay.exe')
} catch {
  foreach($item in Get-ChildItem -LiteralPath $Backup -Force -ErrorAction SilentlyContinue){Copy-Item -LiteralPath $item.FullName -Destination $Target -Recurse -Force}
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("更新失敗，已回復舊版。`n$($_.Exception.Message)",'PhotoRelay 更新') | Out-Null
  Start-Process -FilePath (Join-Path $Target 'PhotoRelay.exe') -ErrorAction SilentlyContinue
}
""";
        File.WriteAllText(script, body);
        Process.Start(new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            ArgumentList = { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
                "-PidToWait", Environment.ProcessId.ToString(), "-Source", stagingDirectory, "-Target", target, "-Backup", backup }
        });
    }

    public void Dispose() => http.Dispose();
}
