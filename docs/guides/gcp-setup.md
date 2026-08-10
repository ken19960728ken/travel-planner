# GCP 金鑰收緊與正式 Map ID 設定

> 2026-08-10 依 Google 官方文件查證後撰寫。文件未明載之處已標註，不臆測。
> 本專案用到的 Google 服務：**Maps JavaScript API**、**Places API (New)**、**Routes API**。

## 快速連結

點進去若跑到別的專案，網址結尾加 `?project=你的專案ID`（或用左上角切換器）。

| 要做的事 | 網址 |
|---|---|
| 編輯金鑰限制 | https://console.cloud.google.com/google/maps-apis/credentials |
| 建立 Map ID | https://console.cloud.google.com/google/maps-apis/studio/maps |
| 每日配額上限 | https://console.cloud.google.com/project/_/google/maps-apis/quotas |
| 帳單預算警示 | https://console.cloud.google.com/billing/budgets |
| 用量圖表（事後檢查） | https://console.cloud.google.com/google/maps-apis/metrics |
| 啟用 **Places API (New)** | https://console.cloud.google.com/apis/library/places.googleapis.com |
| 啟用 Maps JavaScript API | https://console.cloud.google.com/apis/library/maps-backend.googleapis.com |
| 啟用 Routes API | https://console.cloud.google.com/apis/library/routes.googleapis.com |

**出處說明**：Map ID、配額、預算三條是官方文件逐字給的網址；其餘由服務端點名稱推得
（Google 文件未直接列出）。

🚨 **Places 那條特別注意**：新舊版的服務名稱只差一個字尾——
- `places.googleapis.com` = **Places API (New)** ← 你要的
- `places-backend.googleapis.com` = Places API（舊版 Legacy）

用上表的網址進去就不會選錯；若改用搜尋，務必確認標題有 `(New)`。

---

## 你有兩把金鑰，用途與限制方式完全相反

| | 環境變數 | 用途 | 應用程式限制 | API 限制 |
|---|---|---|---|---|
| 瀏覽器金鑰 | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | 前端載入地圖、地點搜尋 | **網站（HTTP 參照網址）** | Maps JavaScript API + Places API **(New)** |
| 伺服器金鑰 | `GOOGLE_MAPS_SERVER_API_KEY` | API route 算路線 | **不設**（見下方說明） | 只勾 Routes API |

瀏覽器金鑰會出現在網頁原始碼裡，**這是設計如此、無法隱藏**——它的防線就是 referrer 限制。
伺服器金鑰絕不可外流，也**絕不能**設 referrer 限制（伺服器請求不帶 referrer，設了就全部被擋）。

---

## 一、瀏覽器金鑰

**位置**：Cloud Console → 左側選單 **APIs & Services → Credentials** → 點金鑰名稱

### 1. 應用程式限制

選 **Websites（HTTP referrers）**，加入這兩條：

```
http://localhost:3000
https://travel-planner-gules-eight-14.vercel.app
```

**不需要**在後面加 `/*`。官方明載：只填網域不帶路徑時「acts as a wildcard and authorizes any
subpath on that hostname」——已經等同萬用字元。（多數瀏覽器基於隱私會剝除跨網域請求的路徑，
路徑層級的限制實務上意義有限。）

⚠️ **同一把金鑰只能選一種應用程式限制類型**（官方：You can set only one type of client
restrictions per API key）。選了 Websites 就不能再加 IP 限制。

#### Vercel preview 網域要不要加？

Vercel 的 preview URL 長這樣（`.vercel.app` 之前整段是單一 DNS label，沒有內部的點）：

```
travel-planner-<hash>-<你的-scope>.vercel.app
travel-planner-git-<branch>-<你的-scope>.vercel.app
```

用 `https://*.vercel.app` 技術上涵蓋得到，**但那會同時涵蓋任何人架在 `.vercel.app` 上的網站**
——`.vercel.app` 是共用託管網域，等於把你的金鑰開放給整個平台的使用者冒用 referrer。

**建議：不要加。** preview 部署的地圖壞掉不影響正式站；真的需要時再臨時加、用完移除。
（Google 官方文件未涵蓋 Vercel 情境，以上是依官方萬用字元規則與 Vercel URL 結構推導。）

### 2. API 限制

選 **Restrict key**，勾選：

- ✅ **Maps JavaScript API**
- ✅ **Places API (New)** ← 注意有 `(New)`

🚨 **這裡最容易出錯**：清單裡「Places API」（舊版 Legacy）與「Places API (New)」是**兩個並存的
獨立項目**，名稱只差三個字。你的程式用的是 `google.maps.places.Place` 與
`PlaceAutocompleteElement`，屬 **New 版**。勾錯舊版 → 地點搜尋整個失效。

若清單裡找不到 Places API (New)，代表專案還沒啟用它，先到
`console.cloud.google.com/apis/library/places.googleapis.com` 按 Enable。

---

## 二、伺服器金鑰

**應用程式限制：留在「None」。**

理由（官方原文）：Google 承認「IP address restrictions might be impractical in some scenarios,
such as ... cloud environments that rely on dynamic IP addresses」。Vercel 的 serverless 出口 IP
不固定，設 IP 限制會隨機被擋。

官方對這種情境給的替代方案是「架設固定出口的 proxy」或「改用 OAuth 2.0」，兩者對這個規模的專案
都過重。**誠實說明：「只設 API 限制、不設應用程式限制」是官方文件未反對、但也未正式背書的折衷。**
在 proxy／OAuth 不可行時，這是可接受的次佳選擇——真正的防線是這把金鑰不進 client bundle
（環境變數無 `NEXT_PUBLIC_` 前綴）。

**API 限制**：選 Restrict key，**只勾 Routes API**。

---

## 三、每日配額上限（防失控）

**位置**：Cloud Console → **Google Maps Platform → Quotas**

選 API → 勾要調整的配額項目 → **Edit quota** → 填數值 → Submit request。

- 每日配額於**太平洋時間午夜**重置
- 官方明載「超過配額到實際開始阻擋之間有延遲」（latency），未給確切數字

建議起始值（依個人使用量抓，之後看實際用量再調）：

| API | 每日上限建議 |
|---|---|
| Maps JavaScript API | 1,000 |
| Places API (New) | 500 |
| Routes API | 500 |

2025 年 3 月的計價改版（Essentials / Pro / Enterprise 分級）改的是計費方式，
官方改版說明未提及配額頁面操作有任何變更。

---

## 四、帳單預算警示

**位置**：Cloud Console → **Billing → Budgets & alerts → Create Budget**

⚠️ **預算警示只會通知，不會自動停用。** 官方原文：

> Setting a budget does *not* automatically cap Google Cloud or Google Maps Platform usage or
> spending. Budget alert emails might prompt you to take action ... but they don't automatically
> prevent the use or billing of your services.

要做到「超過就自動停用」，官方的做法是自行架 Pub/Sub → Cloud Function → 呼叫 Billing API 關帳單，
而且官方**明確警告**：關掉帳單會讓專案內**所有** Google Cloud 服務終止（含你的 Supabase 以外的一切）。
對這個規模的專案，**上一節的配額上限才是真正的硬煞車**，預算警示只當作補充通知。

---

## 五、建立正式 Map ID

**位置**：Cloud Console → **Google Maps Platform → Map Management** → **Create map ID**

- Map type 選 **JavaScript**
- 渲染方式 Raster（預設）或 Vector 都可以——**Advanced Markers 兩種都支援**
  （官方：Advanced markers are compatible with both raster and vector maps），
  本專案的分類圖釘不需要向量地圖
- 建立後會拿到一串 Map ID

`DEMO_MAP_ID` 是 Google 給文件範例用的，官方明載**不可用於正式環境**、也不支援 Cloud Styling。

### 拿到 Map ID 之後

程式已改為讀環境變數（fallback 為 `DEMO_MAP_ID`，未設定時行為不變）：

1. Vercel → 專案 Settings → Environment Variables → 新增
   `NEXT_PUBLIC_GOOGLE_MAP_ID` = 你的 Map ID
2. 本機 `.env.local` 也加同一行（開發時才會一致）
3. 重新部署（Vercel 改環境變數後需要 redeploy 才生效）

若之後要用 Cloud Styling 調整地圖配色，官方僅在 iOS 頁面提到樣式更新約 6 小時反映，
JavaScript 平台未給對應數字（文件未明載）。

---

## 六、設定後怎麼驗證

**先設好再測，不要一次收緊全部。** 建議順序：

1. 先加 referrer（localhost + 正式站兩條都加）→ 存檔 → 等幾分鐘
2. 開正式站，看地圖是否正常
3. 再設 API 限制 → 存檔 → 再測一次
4. 最後設配額與預算

官方未給出限制變更的確切生效時間（只對「復原刪除的金鑰」寫過 a few minutes）。
社群常說 5 分鐘，但那不是官方數字——**沒立刻生效不代表設錯，等幾分鐘再測**。

### 設錯時你會看到的錯誤

| 訊息 | 意思 |
|---|---|
| `RefererNotAllowedMapError` | 目前網域不在 referrer 白名單 → 回頭檢查有沒有打錯字、少了協定 |
| `ApiNotActivatedMapError` | API 根本沒啟用（專案層級，不是金鑰限制） |
| `InvalidKeyMapError` | 金鑰錯誤，或剛建好還沒同步 |
| Routes API 回 `PERMISSION_DENIED`（403） | 伺服器金鑰的問題 |

⚠️ Routes API v2 回的是 **`PERMISSION_DENIED`**，**不是**舊版 Directions API 的 `REQUEST_DENIED`。
除錯搜關鍵字時別搞混。

---

## 參考

- [Google Maps Platform security guidance](https://developers.google.com/maps/api-security-best-practices)
- [Adding restrictions to API keys](https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys)
- [Manage Google Maps Platform costs](https://developers.google.com/maps/billing-and-pricing/manage-costs)
- [Map ID overview](https://developers.google.com/maps/documentation/javascript/map-ids/mapid-over)
- [Maps JavaScript API 錯誤訊息](https://developers.google.com/maps/documentation/javascript/error-messages)
- [Routes API 錯誤處理](https://developers.google.com/maps/documentation/routes/handle-errors)
