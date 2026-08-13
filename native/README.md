# PhotoRelay 原生中央控制程式

`PhotoRelay.exe` 是 Windows 原生 C# WinForms 控制程式，不使用 Electron。

## 職責

- 啟動與停止隨附的 Node.js 圖片服務。
- 顯示服務健康狀態與區域網路共享網址。
- 一鍵開啟瀏覽器工作台、複製其他電腦加入網址。
- 選擇外置資料位置；環境重建時重新指向同一資料夾即可恢復。
- 設定登入 Windows 時自動開啟，以及控制程式啟動後自動開服務。
- 關閉視窗時縮到通知區，避免誤關中央服務。
- 啟動時背景檢查 `blueai2026/HENGDA` 的 GitHub Release；下載更新包後驗證 SHA-256，備份替換失敗會回滾，且不碰外置資料。

## 開發編譯

```powershell
dotnet build .\native\PhotoRelayNative.csproj -c Release
```

## 產生全新設備可直接使用的可攜版

```powershell
.\pack-windows.ps1
```

輸出位於 `dist\PhotoRelay-portable\`，包含：

- `PhotoRelay.exe`：自包含 Windows 程式，不必安裝 .NET。
- `runtime\node.exe`：背景圖片服務執行環境，不必另外安裝 Node.js。
- `app\`：photo-relay 伺服器與網頁工作台。

新設備解壓後雙擊 `PhotoRelay.exe` 即可。資料不應放在可攜程式資料夾內，應選獨立磁碟或 NAS。

## 使用拓撲

一台設備執行 `PhotoRelay.exe` 作為中央主機；其他電腦不執行第二份服務，只需在瀏覽器開啟控制程式顯示的共享網址。手機則掃工作台內各專案的 QR 上傳。
