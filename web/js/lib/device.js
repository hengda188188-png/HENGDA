/**
 * 裝置識別。
 *
 * 說明（很重要，別誤會）：**瀏覽器拿不到手機的硬體序號**，iOS 與 Android 都禁止網頁存取
 * IMEI／序號這類永久識別碼。所以這裡的做法是：第一次開啟時產生一組固定 UUID 存在這台手機的
 * 瀏覽器裡，之後每次掃碼都送同一組；伺服器再把它換算成好念的 4 碼短碼給電腦端指派歸屬。
 * 效果等同「認得這台手機」，但清除瀏覽器資料或換瀏覽器會變成新的一台 —— 這是瀏覽器的限制，不是漏做。
 */
const KEY = 'photo-relay:device-id';

export function deviceId() {
  let id = null;
  try {
    id = localStorage.getItem(KEY);
  } catch {
    /* 無痕模式可能不給存 */
  }
  if (!id) {
    id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 32);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* 存不了就這次連線用，短碼會每次不同，UI 會照實顯示 */
    }
  }
  return id;
}

/** 裝置特徵：只拿「描述這台機器」需要的，不做指紋追蹤 */
export function deviceInfo() {
  return {
    ua: navigator.userAgent,
    platform: navigator.platform ?? '',
    screen: `${screen.width}x${screen.height}`,
    lang: navigator.language ?? '',
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
  };
}
