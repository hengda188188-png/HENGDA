# 建站規格 · photo-relay（手機掃碼傳圖工作台）

- 建立：2026-08-10 ／ 交辦：交代版面 #001
- 一句話：**電腦開網頁 → 出 QR → 手機掃碼傳多張圖 → 電腦即時同步顯示 → 標註名稱/備註、彈窗放大裁切 → 確認後整批上傳到 Google 雲端硬碟。**
- 連線範圍：**同一 Wi-Fi 區網**（QR 指向電腦區網 IP）。不開放公網。
- 使用者範圍：**輕量身分**——可輸入使用者名稱、可建立「專案」做分類（不做密碼帳號系統）。

---

## 一、功能清單（1→10 全列，不留隱含）

| # | 功能 | 說明 |
|---|------|------|
| F1 | 專案管理 | 建立/改名/封存專案；每個專案有獨立 token 與 QR；清單可搜尋+篩選+分頁 |
| F2 | 使用者（輕量） | 建立/選擇使用者名稱；記錄「誰建的專案」「誰上傳的照片」。無密碼、無權限分級 |
| F3 | QR 產生 | 依偵測到的區網 IP 產生 `http://<IP>:<PORT>/m/<token>`；多網卡可切換；同時顯示純文字網址可手打 |
| F4 | 手機上傳頁 | 選多張圖／直接拍照；上傳前在手機端標準化（EXIF 轉正、限制最大邊長、產 512px 縮圖）；顯示每檔進度與結果 |
| F5 | 電腦即時同步 | SSE 推播：手機每上傳完一張，電腦端縮圖牆立即出現（不需重整） |
| F6 | 縮圖牆 | 固定高容器內捲；>50 筆自動分頁；可依上傳者/狀態篩選、依名稱/備註搜尋 |
| F7 | 標註 | 每張照片可填「名稱」與「備註」；即時儲存（樂觀鎖，衝突回 409） |
| F8 | 放大彈窗 | 點縮圖開彈窗看大圖；左右切換；顯示中繼資料（上傳者/時間/尺寸/大小） |
| F9 | 裁切編輯 | 彈窗內裁切（拖曳框＋比例預設 自由/1:1/4:3/3:4/16:9）、旋轉 90°、重設；套用後存為 edited 版本，原圖保留 |
| F10 | 確認/退件 | 每張照片可標記「確認」或「排除」；只有「確認」的會上傳雲端；可全選 |
| F11 | Google Drive 設定 | 設定頁貼 OAuth 用戶端 ID/密鑰 → 一鍵授權 → 存 refresh token；可設定目標資料夾（預設 app 自建根資料夾） |
| F12 | 上傳雲端 | 以專案為單位建立子資料夾 → 逐張上傳（resumable）→ 進度即時顯示 → 回填 Drive 檔案連結；同時上傳 `清單.csv`（名稱/備註/上傳者/時間） |
| F13 | 狀態與重試 | 上傳失敗留錯誤訊息，可單張或整批重試；已上傳過的不重複上傳（冪等） |
| F14 | 刪除 | 單張刪除（本機檔＋紀錄）；專案封存不刪檔 |
| F15 | 設定 | 埠、最大邊長、JPEG 品質、單檔大小上限、單批張數上限、是否保留原始檔 — 皆可設定不寫死 |

---

## 二、業務規則（帶精確約束＋對應測試）

| 規則 | 精確約束 | 測試句 |
|---|---|---|
| R1 上傳授權 | 手機端所有寫入 API 必帶 `token`，且需等於該專案 token；不符→401 | 帶錯 token 上傳 → 401，檔案不落地 |
| R2 檔案型別白名單 | 只收 `image/jpeg` `image/png` `image/webp` `image/heic` `image/heif`；**以副檔名＋magic bytes 雙重判定**，不信任 Content-Type | 上傳改名成 .jpg 的 .exe → 400 `E_BAD_TYPE`，不落地 |
| R3 單檔大小 | 預設 25MB，超過→413，且**串流中途即中止**不寫滿磁碟 | 送 30MB 檔 → 413，data/ 無殘留 |
| R4 單批張數 | 一次請求最多 12 檔、單專案最多 2000 張，超過→400 | 第 2001 張 → 400 `E_LIMIT` |
| R5 檔名安全 | 伺服器**不採用**使用者檔名當路徑；落地檔名 = `<photoId>.<副檔名>`；原始檔名只存進 DB 欄位 | 上傳 `../../evil.jpg` → 檔案落在 data/projects/<id>/original/<photoId>.jpg |
| R6 標註樂觀鎖 | PATCH 照片必帶 `version`；與現值不符→409 並回現值 | 兩個分頁同時改備註，後送出者收 409 |
| R7 只上傳已確認 | Drive 上傳只處理 `status='confirmed'` 的照片；`excluded`/`pending` 一律跳過 | 3 張中只確認 1 張 → Drive 只多 1 個檔 |
| R8 上傳冪等 | 照片已有 `driveFileId` 且內容雜湊未變→跳過不重傳 | 連按兩次「上傳雲端」→ Drive 檔案數不變 |
| R9 裁切正確性 | 套用裁切後 edited 圖尺寸 = 裁切框在原圖座標的整數像素，誤差 ≤1px；原圖不被覆寫 | 對 4000×3000 取中央 1:1 → edited 為 3000×3000，original 檔大小不變 |
| R10 影像標準化 | 上傳前最大邊長預設 2560、JPEG 品質 0.92；EXIF orientation 需轉正 | 直式手機照上傳後在電腦端顯示為直式（非橫躺） |
| R11 速率限制 | 同 IP 每分鐘寫入請求 ≤ 120，超過→429 | 迴圈打 200 次 → 出現 429 |
| R12 Drive 最小權限 | scope 僅 `drive.file`；密鑰只存本機 `data/secrets.json`，**永不回傳前端**（設定頁只顯示遮罩） | GET /api/settings 回應中不含 client_secret / refresh_token |

---

## 二之二、第二輪追加需求（2026-08-10）

| # | 需求 | 落實方式 |
|---|------|----------|
| F16 | 手機端不輸入使用者，改抓設備 | 手機端產生固定 UUID（localStorage）→ 伺服器換算 4 碼短碼。**瀏覽器拿不到硬體序號（iOS/Android 皆禁），這是替代方案，已在 UI 與文件說明** |
| F17 | 電腦端指派歸屬名稱 | 「今日上傳設備」面板直接打字即存；未命名顯示 `#短碼` |
| F18 | 歸屬只綁「當天＋該專案」 | device 記錄 key = 專案 + 日期 + 裝置碼；次日或換專案自動長出新紀錄、label 空白 |
| F19 | 放大要看全圖 | 縮圖改 `object-fit: contain`；放大彈窗圖片絕對定位 + `margin:auto` + `max-*:100%`（原本 `max-height:100%` 在自動高度容器沒有參考值，直式照會溢出） |
| F20 | 縮圖直接顯示並編輯 | 縮圖卡片上兩個就地編輯欄位（名稱／描述）＋設備資訊列（歸屬・短碼・日期）；Enter 存、Esc 還原 |
| F21 | 圖片標註：箭頭／文字／螢光筆 | 編輯器新增三種工具＋五色＋三種粗細＋復原／清除；**標註以向量存 DB**，可再編輯 |
| F22 | 上傳後產生可編輯共用連結 | 上傳完對專案資料夾建立 `anyone/writer` 權限，回傳連結並在 UI 提示「拿到連結的人都能編輯」 |

### 追加業務規則

| 規則 | 精確約束 | 測試句 |
|---|---|---|
| R13 設備當天綁定 | 同一天同一專案同一裝置 → 同一筆；跨日或跨專案 → 新紀錄且 label 清空 | 用 `dateKey='2999-12-31'` 報到 → 新 id、label 為空 |
| R14 歸屬樂觀鎖 | 指派名稱要帶 version，不符回 409 | 連續兩次帶同一 version → 第二次 409 |
| R15 標註可再編輯 | 標註存向量（type/color/size/座標），重開編輯器要載得回來 | 存 3 個標註 → 重開 → 仍是 3 個 |
| R16 標註不重複 | 文字輸入框收起時的 blur 不得重複加入同一段文字 | 打一次字 → 標註數只 +1 |
| R17 共用連結 | 上傳完資料夾必須是「知道連結的人可編輯」；建立失敗不可中斷上傳，要留錯誤 | 權限建立失敗 → 照片照傳，job.errors 有訊息 |

## 二之三、第三輪追加需求（2026-08-10・多人多台共用）

| # | 需求 | 落實方式 |
|---|------|----------|
| F23 | Google 憑證免登入 | 雙模式：OAuth 一次授權／服務帳戶金鑰（零依賴自簽 RS256 JWT）。詳見 README 第二節 |
| F24 | 多台設備、多人、同一專案 | SSE 廣播 + 樂觀鎖；專案事件改成廣播給所有連線電腦 |
| F25 | 跨日／重啟仍要載入過去紀錄 | JSON DB 原子落地 + 啟動自動備份；重啟後專案／照片／標註／設備歸屬／實體檔全在 |
| F26 | 設備面板可回查過去日期 | 「今天／全部日期」切換；全部日期模式標出每筆的日期 |
| F27 | 區網多人存取控制 | **可選的工作台密碼**（預設關閉）；HMAC 簽章 cookie，重啟不用重登；**手機掃碼上傳不受密碼影響** |

### 追加業務規則

| 規則 | 精確約束 | 測試句 |
|---|---|---|
| R18 重啟持久 | 殺掉伺服器再開，專案／照片／名稱備註／標註／設備歸屬／實體檔案全數還在，QR token 不變 | 寫 2 張照片 → kill → 重啟 → 逐項比對全通過 |
| R19 密碼只擋管理端 | 啟用密碼後：`/`、`/api/*` 未登入回 302/401；`/m/*`、`/api/m/*`、`/assets/*` 一律放行 | 有密碼時手機仍能完成整條上傳 |
| R20 重啟不踢人 | cookie 用持久化密鑰簽章，重啟後已登入電腦不用重輸 | kill 重啟後帶舊 cookie 仍 200 |
| R21 改密碼即撤銷 | 改密碼後其他裝置的舊 cookie 立刻失效 | 改完密碼，舊 cookie 回 401 |
| R22 密碼不落明文 | secrets.json 只存 scrypt 雜湊；狀態 API 只回 `{enabled, signedIn}` | 檔案內找不到明文密碼 |
| R23 多台同步 | 一台改設備歸屬／照片名稱／新增專案，其他台不用重整就更新 | 兩個瀏覽器分頁實測同步 |

## 三、資料實體與關聯

```
User(id, name, createdAt)
  └─< Project(id, name, note, ownerUserId→User, token, status, driveFolderId, createdAt, version)
        ├─< Device(id, projectId→Project, dateKey, deviceKey, shortCode, label, model, info, version)
        │     └─ 唯一鍵 = projectId + dateKey + deviceKey（歸屬只對「當天＋該專案」有效）
        └─< Photo(id, projectId→Project, deviceId→Device, dateKey, name, note, status,
                  image{file,w,h,bytes,mime}, thumb{file}, edited{file,w,h,bytes}|null,
                  crop{x,y,w,h,rotate}|null, annotations[]|null,
                  drive{fileId,link,error}|null, createdAt, version)

Annotation = { type:'arrow'|'text'|'marker', color, size,
               from/to | at+text | points[]   ← 一律存「原圖座標」，旋轉只在顯示與輸出時換算 }
```

- 查任一 Photo → 追得到 專案（projectId）＋ 上傳者（uploaderName）＋ 建立者（project.ownerUserId）＋ Drive 落點（drive.fileId / project.driveFolderId）。
- 查任一 Project → 追得到 其所有照片、擁有者、QR token、Drive 資料夾。
- 刪除 Photo → 同步刪 original/thumb/edited 三個實體檔（不留孤兒檔）。

---

## 四、邊界／例外

| 情境 | 處理 |
|---|---|
| 沒有專案就開首頁 | 自動建立「預設專案」並出 QR，不是空白畫面 |
| 多張網卡／VPN（Tailscale）造成 IP 猜錯 | 列出所有候選 IP 讓使用者切換，QR 即時重繪 |
| 手機瀏覽器無法解碼 HEIC | 不強轉，原檔直傳並標記 `needsThumb`，電腦端顯示佔位圖與提示 |
| 上傳中途斷線 | 該檔標記 failed，可單檔重試；不影響其他檔 |
| 同名照片 | 允許同名，落地檔名用 photoId，Drive 端自動加序號前綴 |
| 未設定 Google 憑證就按上傳 | 擋下並導向設定頁，明確說「尚未授權」而非靜默失敗 |
| Drive token 過期 | 用 refresh token 自動換發；換發失敗→回 `E_DRIVE_AUTH` 要求重新授權 |
| 磁碟寫入失敗 | 回 500 並在 UI 顯示紅字錯誤，不留半截檔（先寫 .part 再 rename） |
| 兩台手機同時傳 | 各自獨立寫檔；DB 寫入序列化（單行程 + 佇列），不互蓋 |
| 專案 >50、照片 >50 | 一律搜尋+篩選+分頁三件套 |
| 伺服器重啟 | DB 落地 JSON，重啟後專案/照片/標註全在；SSE 前端自動重連 |

---

## 五、情境演算（七軸）

- **資料**：空專案、單張、2000 張、超大圖(50MP)、0 位元組檔、同雜湊重複圖 → 皆有對應規則(R3/R4/R8)。
- **來源與外部依賴**：Google API 5xx/429 → 指數退避重試 3 次；離線 → 上傳按鈕給明確錯誤不轉圈。
- **時間**：token 無期限但可「重新產生」使其失效；上傳時間用 ISO 字串存。
- **執行與韌性**：JSON DB 原子寫（tmp→rename）；每次啟動備份前一版 db.json。
- **人與權限**：區網內任何人掃到 QR 都能傳（設計如此）→ 故 token 可隨時重產；管理端不對外開放。
- **介面**：手機直式/橫式、360px 最小寬；縮圖牆固定高內捲不撐版；彈窗 z 階梯 1000/1100/2000。
- **衍生**：有資料→搜尋/篩選/分頁；有多筆→比對(暫不做，記入未做清單)；有使用者→專案分類；有自動流程→錯誤留痕與重試。

---

## 六、本機環境限制（誠實標注）

本機 `C:\AI_Workspace` 只有 claude-sync 骨架，**沒有** `products/ui-kit`、`tools/ui-constraints/check.mjs`、`tools/web-standard-check.mjs`、`tools/feature-map/fm.mjs`。
→ 本專案自帶 `test/gate.mjs`（自寫檢查：容器約束/寬度/彩虹漸層/alt/aria/硬編碼字串）與 `test/run.mjs`（業務規則測試），並仍產出 `feature-map.json` 供回主基地後直接跑官方閘門。
→ 未跑到的官方閘門會在 README「未過閘門」列明。

---

## 七、多人／跨日／跨設備架構調整（2026-08-11・DeepSeek 諮詢 + Google 官方文件交叉驗證）

**背景**：伺服器實際運作環境常是「一台會被 IT 政策定期還原成全新系統的電腦」——本機磁碟（`data/db.json`、`data/secrets.json`、`data/projects/*/original|thumb|edited`）隨時可能在下次開機後消失。核心矛盾：**運算節點不可信賴，但資料要跨天跨人跨設備延續**。本節記錄諮詢 DeepSeek 兩輪 + 用 Google 官方文件交叉查證後的結論（諮詢原文見 `docs/諮詢紀錄/deepseek-consult.md`）。

### 7.1 資料分層原則
把「運算」跟「持久狀態」拆開：伺服器本身視為**用完即丟的無狀態節點**，所有真正不能消失的東西都推到本機磁碟以外。

| 資料 | 現況（本機） | 建議去向 | 優先級 |
|---|---|---|---|
| 照片原始檔/縮圖/已編輯檔 | `data/projects/*/original\|thumb\|edited` | 手機上傳時直接串流進 Google Drive，本機只留暫存快取（丟了可重抓） | 高 |
| 中繼資料（專案/照片/標註/設備歸屬） | `data/db.json` 單一 JSON | 見 7.3（不引入資料庫 SDK 的替代方案） | 高 |
| Google 憑證（clientId/clientSecret/refreshToken） | `data/secrets.json` 明碼 | 見 7.2（改用 Device Flow 可從根本上不必「保存」refreshToken 在本機也能長期使用；退一步至少要能從本機以外的地方復原） | 高 |
| 暫存縮圖快取、SSE 連線狀態 | 本機記憶體/暫存 | 留本機沒差，丟了會自己重建 | 低 |

### 7.2 Google OAuth：改用 Device Authorization Flow（已對照官方文件驗證，**修正 DeepSeek 兩輪回答中的錯誤**）

**verified 正確流程**（`developers.google.com/identity/protocols/oauth2/limited-input-device`）：
1. `POST https://oauth2.googleapis.com/device/code`（帶 `client_id`+`scope`）→ 拿 `device_code`+`user_code`+一個給人看的網址。
2. 使用者在**任何一台裝置**（不必是伺服器本身）開瀏覽器輸入 `user_code` 完成登入。
3. 伺服器輪詢 `POST https://oauth2.googleapis.com/token`，`grant_type=urn:ietf:params:oauth:grant-type:device_code`，換到 `access_token`+`refresh_token`。

**⚠ 兩處親自查證後推翻 DeepSeek 原始建議的地方，別照抄：**
- DeepSeek 第一輪講輪詢端點是走 `oauth2Client.generateAuthUrl()/getToken()`（那是**標準瀏覽器導向 OAuth** 的方法，不是 Device Flow）；第二輪「修正」後仍寫成 `https://accounts.google.com/o/oauth2/token`——**兩次都錯**，官方文件明確是 `https://oauth2.googleapis.com/token`（跟本專案現有 `src/lib/google-drive.mjs` 的 `TOKEN_ENDPOINT` 剛好是同一個，這點可以直接沿用）。
- DeepSeek 說「你現在的『電腦版應用程式』client 類型是對的」——**這是錯的**。Google 官方文件明講 Device Flow **必須用「TVs and Limited Input devices」類型的 OAuth 用戶端**，用錯類型會直接噴 `invalid_client`。要導入 Device Flow，得先去 Google Cloud Console **另外建一個「TVs and Limited Input devices」類型的用戶端**，不能沿用現有那組 `433548144425-...apps.googleusercontent.com`。
- 已確認 `drive.file` scope 在 Device Flow 底下可正常使用，不用擴大權限範圍。

**這樣做解決什麼**：伺服器不必自己開瀏覽器完成登入（本來就常常沒有互動瀏覽器可用），使用者可以用**自己的手機**掃/開連結完成授權；且伺服器被重置後只要重新走一次「顯示 user_code→等人在手機上輸入」，不必再依賴本機殘留的 session 或人工複製貼上 Client Secret JSON。

### 7.3 中繼資料同步：在「零外部套件」原則下的做法
本專案刻意零 npm 依賴（純內建 `fetch`/`http`，方便任何一台新裝 Node.js 的電腦直接跑，不管套件版本問題）；**這是刻意的設計原則，不是技術債，不建議為了雲端同步而破例**。DeepSeek 建議的 Firebase/Supabase 走 REST API（不裝 SDK）在技術上可行，但仍是「引入一個外部雲端服務依賴＋要另外辦帳號金鑰」，優先順序放在 Device Flow 之後：先確認遷移真的必要、且評估過金鑰又要新增一份要保管的憑證（等於沒有真的減少『憑證管理』這件事的複雜度）。**這部分還沒有定案，是待評估項，不是立刻要做的結論**——列出來是給下一輪決策用，不是已核准的架構。

### 7.4 多人多裝置 UX 缺口（2026-08-11 對照真實程式碼查證，DeepSeek 列的 3 項有 2 項其實已存在，別照單全收）
1. **連線狀態指示**——✅**已實作**（2026-08-11）：`web/js/lib/api.js` 的 `subscribeEvents()` 新增 `onStatusChange` 回呼，暴露 `connecting/open/reconnecting` 三態；`main.js` 的 `renderConnStatus()` 驅動 header 上的 `.conn-status` 燈號（灰/綠/黃底 pulse）。**真的關掉伺服器驗證過**：綠「即時同步中」→ kill server 後變黃「連線中斷，補連線中…」（脈動動畫）→ 重啟伺服器後瀏覽器原生 EventSource 自動重連，燈號自動變回綠——整個循環截圖存證，不是模擬。
2. ~~新照片到達提示~~——**查過是誤判，其實已經有**：`main.js` 的 `resubscribe()` 裡 `photo:created` 事件已經會 `toast(t('event.uploadedBy', {who}))`（「{誰} 上傳了一張照片」），不需要再做。
3. ~~同時編輯衝突提示~~——**查過也已經有**：`viewer.js` 的 `flushSave()` 對 409 衝突會 `replacePhoto(err.extra.current, {force:true})` + `toastError(t('viewer.conflict'))`（「這張照片在別的裝置被改過，已載入最新內容」）。
4. 「連結分享即可用」已確認可行（見前段對話）：`/m/<token>` 純看 token 是否有效，不管連結是掃 QR 還是直接轉發拿到的，同區網內都能用——✅**UI 提示已補**（2026-08-11）：QR 面板新增一行「這組網址誰都能傳——不一定要掃碼，直接把網址傳給同事」，複製按鈕文字也改成「複製網址（可直接傳給同事）」。真瀏覽器截圖確認正常換行顯示。
5. ~~身份跨日跨專案重填~~——**2026-08-11 需求澄清後撤回**：手機是公務機（共用裝置），今天/明天可能不同人用，歸屬綁「專案＋這一天」才是對的，不是缺陷，不用改。
6. **縮圖卡快速操作只有 hover 才看得到**——✅**已修復**（2026-08-11）：`.thumb .quick` 改成常駐顯示（平常 opacity .85，hover/focus 提到 1），觸控/筆電使用者不用先知道要 hover 才找得到快速上傳/複製連結按鈕。
7. **多專案並行時側欄看不出最近活動**——✅**已修復**（2026-08-11）：`store.mjs` 新增 `touchProject()`，在照片新增/編輯/上傳/刪除、設備報到、專案設定變更時更新 `project.updatedAt`；`listProjects` 改依 `updatedAt` 排序（新→舊）；側欄每個專案下方顯示相對時間（剛剛/N分鐘前/N小時前/N天前）。**真的建了第二個測試專案驗證**：新專案「剛剛」排在舊專案「4小時前」上方，驗證完畢已封存清除測試資料。

### 7.5 優先順序（2026-08-11 更新進度）
1. ✅ 連線狀態指示（已完成並真實驗證，見 7.4-1）。
2. ✅ 縮圖快速操作常駐顯示（見 7.4-6）。
3. ✅ 專案依最近活動排序＋相對時間（見 7.4-7）。
4. Device Flow 取代目前的瀏覽器導向 OAuth（含另建 TV/Limited-Input 類型 client）——**還沒動工**，是解決「重置後要重新授權」最大痛點的下一步。
5. 中繼資料/照片雲端化——工時大、且要先想清楚要不要真的引入外部服務依賴，暫列為「待評估」不是「待辦」。
6. 「連結可分享」的 UI 明示——工時很低，可下一輪做。

這四筆通用 UX 情境（禁空白框架／連線狀態燈／常駐快速操作／最近活動排序＋相對時間／共用裝置每日重指派）已蒸餾進基地黃金標準 `docs/知識庫/網頁知識庫/00-黃金標準/網頁設計規範.md` 第九章「情境對照 UX 速查表」，之後其他專案遇到同類情境直接查表沿用，不用重新設計。

### 7.6 手機端上傳頁 UX 諮詢（2026-08-11・DeepSeek，對照真實程式碼查證後 3/5 項建議是誤判，別照單全收）

**DeepSeek 說「缺失敗重試」「缺失敗自動跳過繼續傳下一張」——查程式碼證實兩項都已經做了**：`web/js/mobile/main.js` `renderQueue()` 失敗項目本來就有「重試」按鈕；`runQueue()` 的 while 迴圈只找 `status==='waiting'` 的項目，失敗項目自動被跳過、不擋後面的照片繼續傳。**這兩項不用重做。**
**「剩餘張數造成壓力」的批評也站不住腳**：現有文案「這個專案還可上傳 N 張」語意已經清楚（講明是「這個專案」的量），DeepSeek 講的語意不明情境沒有真的對應到現有文案。

**站得住腳、真的是缺口的兩點：**
1. **拍照當下無法補說明,要等電腦端才能命名/描述,中間有記憶落差**——✅**已實作**（2026-08-11，選文字方案，沒做語音）：手機端動作卡新增「備註（選填）」輸入框，拍照/選圖前先打（或留空照舊直接傳），套用到那一批選的所有照片，送出後自動清空避免誤套到下一批。全鏈路打通：`web/js/mobile/main.js`（讀值→帶進 `enqueue()`→`uploadOne()`）→`web/js/lib/uploader.js`（`uploadPhoto` 新增 `note` 參數）→`src/routes/mobile.mjs`（`postPhoto` 收 `body.note`）→`src/store.mjs`（`createPhoto` 新增 `note` 參數，`cleanText` 限 1000 字）。**真實驗證**：直接打 API（`POST /api/m/:token/photos` 帶中文 `note`）建照片→查 `data/db.json` 確認中文正確存入（非 mojibake，用檔案傳遞 body 避開 bash 傳中文亂碼的坑）→重新整理桌面頁確認縮圖卡的描述欄位自動帶出這行字，三段全部串通、測試資料已清除。
2. **完成後沒有明確的「這批傳完了」收尾畫面**——現況其實已經有「每張顯示『完成』狀態＋累計『你已上傳 N 張』」，不算 DeepSeek 講的「頁面一片沉寂」那麼嚴重，但確實沒有整批完成的收尾提示，屬於低優先的錦上添花，不是急迫缺口。

**技術選型（網頁 vs App）交叉驗證確認正確**：DeepSeek 分析與使用者既有情境（公務機禁裝 App、掃碼即用、多人共用裝置）完全吻合，維持現有純網頁路線，不用考慮改 App。
