using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace PhotoRelayNative;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

internal sealed class LauncherSettings
{
    public string DataDirectory { get; set; } = "";
    public bool StartWithWindows { get; set; }
    public bool StartServerOnLaunch { get; set; } = true;
    public bool CheckUpdatesOnLaunch { get; set; } = true;
}

internal sealed class MainForm : Form
{
    private const string RunValueName = "PhotoRelay";
    private readonly string settingsDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PhotoRelay");
    private readonly string settingsFile;
    private readonly Label statusLabel = new();
    private readonly Label statusDetail = new();
    private readonly TextBox dataDirectory = new();
    private readonly ComboBox sharedAddress = new();
    private readonly Button startButton = new();
    private readonly Button stopButton = new();
    private readonly Button openButton = new();
    private readonly Button copyButton = new();
    private readonly Button updateButton = new();
    private readonly CheckBox autoStart = new();
    private readonly CheckBox autoServer = new();
    private readonly TextBox logBox = new();
    private readonly System.Windows.Forms.Timer healthTimer = new() { Interval = 1500 };
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(1) };
    private readonly NotifyIcon tray = new();
    private readonly UpdateService updater = new();
    private Process? server;
    private LauncherSettings config;
    private int port = 4901;
    private bool closing;

    public MainForm()
    {
        settingsFile = Path.Combine(settingsDirectory, "launcher.json");
        config = LoadSettings();
        BuildUi();
        RefreshAddresses();
        ApplySettingsToUi();
        healthTimer.Tick += async (_, _) => await CheckHealthAsync();
        healthTimer.Start();
        Shown += async (_, _) =>
        {
            if (config.StartServerOnLaunch) await StartServerAsync();
            if (config.CheckUpdatesOnLaunch) await CheckForUpdatesAsync(silent: true);
        };
        FormClosing += OnFormClosing;
    }

    private void BuildUi()
    {
        Text = "PhotoRelay 中央工作台";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(760, 610);
        Size = new Size(850, 680);
        Font = new Font("Microsoft JhengHei UI", 10F);
        BackColor = Color.FromArgb(245, 247, 250);

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(24),
            ColumnCount = 1,
            RowCount = 5,
        };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(root);

        var title = new Label
        {
            AutoSize = true,
            Text = "PhotoRelay 中央工作台",
            Font = new Font(Font.FontFamily, 20F, FontStyle.Bold),
            ForeColor = Color.FromArgb(24, 32, 48),
            Margin = new Padding(0, 0, 0, 4),
        };
        var subtitle = new Label
        {
            AutoSize = true,
            Text = "這台電腦提供中央服務；手機掃碼上傳，其他電腦用瀏覽器共同整理。",
            ForeColor = Color.FromArgb(87, 98, 116),
            Margin = new Padding(0, 0, 0, 18),
        };
        var heading = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, Dock = DockStyle.Fill };
        heading.Controls.Add(title);
        heading.Controls.Add(subtitle);
        root.Controls.Add(heading);

        var statusCard = Card();
        var statusRow = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2 };
        statusRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        statusRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        statusLabel.AutoSize = true;
        statusLabel.Font = new Font(Font.FontFamily, 14F, FontStyle.Bold);
        statusDetail.AutoSize = true;
        statusDetail.ForeColor = Color.FromArgb(87, 98, 116);
        var statusText = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
        statusText.Controls.Add(statusLabel);
        statusText.Controls.Add(statusDetail);
        statusRow.Controls.Add(statusText, 0, 0);
        var buttons = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
        startButton.Text = "啟動服務";
        stopButton.Text = "停止";
        openButton.Text = "開啟工作台";
        updateButton.Text = $"檢查更新 v{updater.CurrentVersion.ToString(3)}";
        StyleButton(startButton, true);
        StyleButton(stopButton);
        StyleButton(openButton);
        StyleButton(updateButton);
        startButton.Click += async (_, _) => await StartServerAsync();
        stopButton.Click += (_, _) => StopServer();
        openButton.Click += (_, _) => OpenBrowser(LocalUrl());
        updateButton.Click += async (_, _) => await CheckForUpdatesAsync(silent: false);
        buttons.Controls.AddRange([startButton, stopButton, openButton, updateButton]);
        statusRow.Controls.Add(buttons, 1, 0);
        statusCard.Controls.Add(statusRow);
        root.Controls.Add(statusCard);

        var joinCard = Card();
        joinCard.Controls.Add(SectionLabel("其他電腦加入"));
        var joinHint = new Label
        {
            AutoSize = true,
            Text = "在同一個網路的其他電腦開啟以下網址，不必安裝本工具。",
            ForeColor = Color.FromArgb(87, 98, 116),
            Margin = new Padding(0, 0, 0, 8),
        };
        joinCard.Controls.Add(joinHint);
        var joinRow = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Top, ColumnCount = 3 };
        joinRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        joinRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        joinRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        sharedAddress.DropDownStyle = ComboBoxStyle.DropDownList;
        sharedAddress.Dock = DockStyle.Fill;
        sharedAddress.MinimumSize = new Size(360, 36);
        copyButton.Text = "複製網址";
        var refreshButton = new Button { Text = "重新偵測" };
        StyleButton(copyButton);
        StyleButton(refreshButton);
        copyButton.Click += (_, _) => CopySharedAddress();
        refreshButton.Click += (_, _) => RefreshAddresses();
        joinRow.Controls.Add(sharedAddress, 0, 0);
        joinRow.Controls.Add(copyButton, 1, 0);
        joinRow.Controls.Add(refreshButton, 2, 0);
        joinCard.Controls.Add(joinRow);
        root.Controls.Add(joinCard);

        var storageCard = Card();
        storageCard.Controls.Add(SectionLabel("資料保存與快速恢復"));
        var storageHint = new Label
        {
            AutoSize = true,
            Text = "請選擇不會被系統還原的磁碟或 NAS 資料夾；換主機時重新指向同一位置即可恢復。",
            ForeColor = Color.FromArgb(87, 98, 116),
            Margin = new Padding(0, 0, 0, 8),
        };
        storageCard.Controls.Add(storageHint);
        var storageRow = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Top, ColumnCount = 3 };
        storageRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        storageRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        storageRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        dataDirectory.Dock = DockStyle.Fill;
        dataDirectory.MinimumSize = new Size(360, 36);
        dataDirectory.ReadOnly = true;
        var browse = new Button { Text = "選擇位置" };
        var openData = new Button { Text = "開啟資料夾" };
        StyleButton(browse);
        StyleButton(openData);
        browse.Click += (_, _) => ChooseDataDirectory();
        openData.Click += (_, _) => OpenDataDirectory();
        storageRow.Controls.Add(dataDirectory, 0, 0);
        storageRow.Controls.Add(browse, 1, 0);
        storageRow.Controls.Add(openData, 2, 0);
        storageCard.Controls.Add(storageRow);
        autoStart.Text = "登入 Windows 時自動開啟控制程式";
        autoServer.Text = "控制程式開啟後自動啟動中央服務";
        autoStart.AutoSize = autoServer.AutoSize = true;
        autoStart.Margin = new Padding(0, 12, 18, 0);
        autoServer.Margin = new Padding(0, 12, 0, 0);
        autoStart.CheckedChanged += (_, _) => UpdateAutoStart();
        autoServer.CheckedChanged += (_, _) => { config.StartServerOnLaunch = autoServer.Checked; SaveSettings(); };
        var options = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, WrapContents = true };
        options.Controls.Add(autoStart);
        options.Controls.Add(autoServer);
        storageCard.Controls.Add(options);
        root.Controls.Add(storageCard);

        var logCard = Card();
        logCard.Controls.Add(SectionLabel("運行紀錄"));
        logBox.Dock = DockStyle.Fill;
        logBox.Multiline = true;
        logBox.ReadOnly = true;
        logBox.ScrollBars = ScrollBars.Vertical;
        logBox.BackColor = Color.FromArgb(20, 25, 36);
        logBox.ForeColor = Color.FromArgb(222, 229, 239);
        logBox.Font = new Font("Consolas", 9F);
        logCard.Controls.Add(logBox);
        root.Controls.Add(logCard);

        tray.Text = "PhotoRelay 中央工作台";
        tray.Icon = SystemIcons.Application;
        tray.Visible = true;
        tray.DoubleClick += (_, _) => RestoreWindow();
        tray.ContextMenuStrip = new ContextMenuStrip();
        tray.ContextMenuStrip.Items.Add("開啟控制程式", null, (_, _) => RestoreWindow());
        tray.ContextMenuStrip.Items.Add("開啟工作台", null, (_, _) => OpenBrowser(LocalUrl()));
        tray.ContextMenuStrip.Items.Add("檢查更新", null, async (_, _) => await CheckForUpdatesAsync(silent: false));
        tray.ContextMenuStrip.Items.Add("結束", null, (_, _) => { closing = true; Close(); });

        Resize += (_, _) =>
        {
            if (WindowState == FormWindowState.Minimized) Hide();
        };
        SetStoppedState("尚未啟動");
    }

    private static Panel Card()
    {
        return new FlowLayoutPanel
        {
            AutoSize = false,
            Height = 125,
            Dock = DockStyle.Top,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            Padding = new Padding(16),
            Margin = new Padding(0, 0, 0, 14),
            BackColor = Color.White,
        };
    }

    private static Label SectionLabel(string text) => new()
    {
        AutoSize = true,
        Text = text,
        Font = new Font("Microsoft JhengHei UI", 11F, FontStyle.Bold),
        ForeColor = Color.FromArgb(24, 32, 48),
        Margin = new Padding(0, 0, 0, 7),
    };

    private static void StyleButton(Button button, bool primary = false)
    {
        button.AutoSize = true;
        button.MinimumSize = new Size(96, 36);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderColor = primary ? Color.FromArgb(35, 95, 205) : Color.FromArgb(194, 202, 214);
        button.BackColor = primary ? Color.FromArgb(35, 95, 205) : Color.White;
        button.ForeColor = primary ? Color.White : Color.FromArgb(34, 43, 58);
        button.Margin = new Padding(6, 0, 0, 0);
    }

    private LauncherSettings LoadSettings()
    {
        try
        {
            if (File.Exists(settingsFile))
                return JsonSerializer.Deserialize<LauncherSettings>(File.ReadAllText(settingsFile)) ?? new LauncherSettings();
        }
        catch { }
        return new LauncherSettings();
    }

    private void ApplySettingsToUi()
    {
        if (string.IsNullOrWhiteSpace(config.DataDirectory))
            config.DataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PhotoRelay", "data");
        dataDirectory.Text = config.DataDirectory;
        autoStart.Checked = IsAutoStartEnabled();
        autoServer.Checked = config.StartServerOnLaunch;
        SaveSettings();
    }

    private void SaveSettings()
    {
        Directory.CreateDirectory(settingsDirectory);
        File.WriteAllText(settingsFile, JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true }));
    }

    private string AppDirectory()
    {
        var packaged = Path.Combine(AppContext.BaseDirectory, "app");
        if (File.Exists(Path.Combine(packaged, "server.mjs"))) return packaged;
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."));
    }

    private string? NodeExecutable()
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, "runtime", "node.exe");
        if (File.Exists(bundled)) return bundled;
        var system = FindOnPath("node.exe");
        return system;
    }

    private static string? FindOnPath(string fileName)
    {
        foreach (var part in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            try
            {
                var candidate = Path.Combine(part.Trim(), fileName);
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        return null;
    }

    private async Task StartServerAsync()
    {
        if (server is { HasExited: false }) return;
        var node = NodeExecutable();
        var app = AppDirectory();
        var entry = Path.Combine(app, "server.mjs");
        if (node is null || !File.Exists(entry))
        {
            MessageBox.Show("找不到隨附的 Node 執行環境或 app\\server.mjs。請重新取得完整可攜版。", "無法啟動", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        Directory.CreateDirectory(config.DataDirectory);
        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = $"\"{entry}\"",
            WorkingDirectory = app,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.Environment["PHOTO_RELAY_DATA"] = config.DataDirectory;
        server = new Process { StartInfo = psi, EnableRaisingEvents = true };
        server.OutputDataReceived += (_, e) => { if (e.Data != null) AppendLog(e.Data); };
        server.ErrorDataReceived += (_, e) => { if (e.Data != null) AppendLog(e.Data); };
        server.Exited += (_, _) => BeginInvoke(() => SetStoppedState("服務已停止"));
        try
        {
            server.Start();
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();
            AppendLog($"啟動中央服務，資料位置：{config.DataDirectory}");
            statusLabel.Text = "正在啟動…";
            statusLabel.ForeColor = Color.FromArgb(170, 105, 0);
            startButton.Enabled = false;
            stopButton.Enabled = true;
            for (var i = 0; i < 20; i++)
            {
                await Task.Delay(250);
                if (await IsHealthyAsync()) break;
            }
            await CheckHealthAsync();
        }
        catch (Exception ex)
        {
            AppendLog($"啟動失敗：{ex.Message}");
            SetStoppedState("啟動失敗");
        }
    }

    private void StopServer()
    {
        try
        {
            if (server is { HasExited: false })
            {
                server.Kill(entireProcessTree: true);
                server.WaitForExit(3000);
            }
        }
        catch (Exception ex) { AppendLog($"停止服務時發生問題：{ex.Message}"); }
        finally
        {
            server?.Dispose();
            server = null;
            SetStoppedState("服務已停止");
        }
    }

    private async Task<bool> IsHealthyAsync()
    {
        try
        {
            using var response = await http.GetAsync($"http://127.0.0.1:{port}/healthz");
            return response.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    private async Task CheckHealthAsync()
    {
        if (await IsHealthyAsync())
        {
            statusLabel.Text = "中央服務運行中";
            statusLabel.ForeColor = Color.FromArgb(20, 128, 76);
            statusDetail.Text = $"本機：{LocalUrl()}　｜　其他電腦可使用下方共享網址";
            startButton.Enabled = false;
            stopButton.Enabled = true;
            openButton.Enabled = true;
            copyButton.Enabled = sharedAddress.Items.Count > 0;
        }
        else if (server is null || server.HasExited)
        {
            SetStoppedState("中央服務未啟動");
        }
    }

    private void SetStoppedState(string detail)
    {
        statusLabel.Text = "中央服務已停止";
        statusLabel.ForeColor = Color.FromArgb(170, 50, 50);
        statusDetail.Text = detail;
        startButton.Enabled = true;
        stopButton.Enabled = false;
        openButton.Enabled = false;
    }

    private void RefreshAddresses()
    {
        var current = sharedAddress.SelectedItem?.ToString();
        sharedAddress.Items.Clear();
        foreach (var address in LanAddresses()) sharedAddress.Items.Add($"http://{address}:{port}");
        if (current != null && sharedAddress.Items.Contains(current)) sharedAddress.SelectedItem = current;
        else if (sharedAddress.Items.Count > 0) sharedAddress.SelectedIndex = 0;
        copyButton.Enabled = sharedAddress.Items.Count > 0;
    }

    private static IEnumerable<string> LanAddresses()
    {
        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a.Address))
            .Select(a => a.Address.ToString())
            .Distinct();
    }

    private string LocalUrl() => $"http://localhost:{port}";

    private void CopySharedAddress()
    {
        if (sharedAddress.SelectedItem is not string url) return;
        Clipboard.SetText(url);
        statusDetail.Text = $"已複製：{url}";
    }

    private static void OpenBrowser(string url)
    {
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    private void ChooseDataDirectory()
    {
        if (server is { HasExited: false })
        {
            MessageBox.Show("請先停止中央服務，再更換資料位置。", "服務正在運行", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        using var dialog = new FolderBrowserDialog
        {
            Description = "選擇 PhotoRelay 資料保存位置（建議獨立磁碟或 NAS）",
            SelectedPath = config.DataDirectory,
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        config.DataDirectory = dialog.SelectedPath;
        dataDirectory.Text = config.DataDirectory;
        SaveSettings();
        AppendLog($"資料位置已改為：{config.DataDirectory}");
    }

    private void OpenDataDirectory()
    {
        Directory.CreateDirectory(config.DataDirectory);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{config.DataDirectory}\"") { UseShellExecute = true });
    }

    private bool IsAutoStartEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        return key?.GetValue(RunValueName) is string;
    }

    private void UpdateAutoStart()
    {
        config.StartWithWindows = autoStart.Checked;
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        if (autoStart.Checked)
            key.SetValue(RunValueName, $"\"{Environment.ProcessPath}\" --autostart");
        else
            key.DeleteValue(RunValueName, false);
        SaveSettings();
    }

    private void AppendLog(string message)
    {
        if (InvokeRequired) { BeginInvoke(() => AppendLog(message)); return; }
        logBox.AppendText($"[{DateTime.Now:HH:mm:ss}] {message}{Environment.NewLine}");
    }

    private async Task CheckForUpdatesAsync(bool silent)
    {
        updateButton.Enabled = false;
        var original = updateButton.Text;
        updateButton.Text = "正在檢查…";
        try
        {
            var update = await updater.CheckAsync();
            if (update is null)
            {
                if (!silent) MessageBox.Show($"目前已是最新版 v{updater.CurrentVersion.ToString(3)}。", "PhotoRelay 更新",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var answer = MessageBox.Show(
                $"發現新版 {update.Tag}。\n\n{TrimNotes(update.Notes)}\n\n現在下載並安裝嗎？\n更新不會改動照片、專案資料或 Google 憑證。",
                "PhotoRelay 有新版本", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
            if (answer != DialogResult.Yes) return;
            updateButton.Text = "下載更新 0%";
            var progress = new Progress<int>(value => updateButton.Text = $"下載更新 {value}%");
            var staging = await updater.DownloadAndVerifyAsync(update, progress);
            AppendLog($"更新包 {update.Tag} 已下載並通過 SHA-256 驗證。");
            StopServer();
            updater.LaunchInstaller(staging);
            closing = true;
            Close();
        }
        catch (Exception ex)
        {
            AppendLog($"更新檢查失敗：{ex.Message}");
            if (!silent) MessageBox.Show($"無法完成更新：\n{ex.Message}", "PhotoRelay 更新",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            if (!IsDisposed)
            {
                updateButton.Enabled = true;
                updateButton.Text = original;
            }
        }
    }

    private static string TrimNotes(string notes)
    {
        var clean = notes.Trim();
        return clean.Length <= 500 ? clean : clean[..500] + "…";
    }

    private void RestoreWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!closing && e.CloseReason == CloseReason.UserClosing && server is { HasExited: false })
        {
            e.Cancel = true;
            Hide();
            tray.ShowBalloonTip(1800, "PhotoRelay 仍在運行", "中央服務已縮到通知區；其他電腦仍可繼續使用。", ToolTipIcon.Info);
            return;
        }
        closing = true;
        healthTimer.Stop();
        StopServer();
        tray.Visible = false;
        tray.Dispose();
        http.Dispose();
        updater.Dispose();
    }
}
