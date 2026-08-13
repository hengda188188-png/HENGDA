# GitHub Releases 與自動更新

PhotoRelay 的正式更新來源固定為 `hengda188188-png/HENGDA`。一般使用者不需要 GitHub 帳號；因此倉庫與 Release 資產必須公開可讀，程式中禁止放入 GitHub Token。

## 發布新版

1. 修改 `native/PhotoRelayNative.csproj` 的 `<Version>`。
2. 完整執行 `npm.cmd test`，並在真 portable 驗收。
3. 提交後建立同版號標籤，例如版本 `0.3.0` 對應 `v0.3.0`。
4. 推送標籤；GitHub Actions 自動建置並發布：
   - `PhotoRelay-portable-win-x64.zip`
   - `PhotoRelay-portable-win-x64.zip.sha256`

資產名稱是更新契約，不得任意改名。Release 的版本標籤必須是可解析的 `v主版.次版.修訂版`。

## 客戶端更新流程

程式啟動後背景查詢 GitHub Latest Release，也提供「檢查更新」按鈕。發現較新版本時由使用者確認，之後：

1. 下載 ZIP 與 SHA-256。
2. 校驗失敗立即停止，不執行未知內容。
3. 驗證 ZIP 內必須包含 `PhotoRelay.exe`、`app/server.mjs`、`runtime/node.exe`。
4. 停止圖片服務，退出主程式。
5. 外部更新程序先備份舊版，再替換程式並重啟。
6. 替換失敗時還原備份並重新啟動舊版。

照片、專案、Google 憑證與控制程式設定位於外置資料目錄／`%LOCALAPPDATA%\PhotoRelay`，不在更新資產替換範圍內。

## 第一版銜接限制

只有內含 `UpdateService` 的版本才能自動更新。更早的 portable 版本必須人工下載並覆蓋一次；從 v0.3.0 起才進入連續自動更新鏈。
