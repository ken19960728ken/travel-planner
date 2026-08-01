'use client'

import { unstable_catchError, type ErrorInfo } from 'next/error'

// I-2（審查更正）：先前的註解誤指崩潰源頭是 vis.gl 的 AuthFailureMessage 降級畫面渲染前丟出的
// TypeError——讀 node_modules/@vis.gl/react-google-maps/dist/index.modern.mjs 後這個說法被證偽：
// AUTH_FAILURE 這個 loading status 在目前安裝的 v1.9.0 從未被指派（updateLoadingStatus 全模組只有
// LOADED/LOADING/FAILED 三種呼叫），AuthFailureMessage 是不可達死碼、不會渲染，也就不會在渲染前拋錯。
// 真正對得上使用者回報現象（owner 開頁面整頁崩潰）的嫌疑犯是 PlaceSearch.tsx 建構
// `new places.PlaceAutocompleteElement()`——金鑰缺 Places (New) 權限時已知會拋出，且發生在
// useEffect 內、會冒泡到最近的 error boundary。已在 PlaceSearch.tsx 補 try/catch 從源頭避免拋出，
// 這裡的 boundary 上提到涵蓋整個行程頁內容（不只地圖）是防禦性的最後防線：PlaceSearch 位在側欄，
// 跟地圖是同一層的兄弟節點，只包地圖的 boundary 結構上接不到 PlaceSearch 的例外。
// 誠實聲明：本輪只有原始碼比對與邏輯推論，尚未用真的壞金鑰跑 production build 實測釘死崩潰堆疊
// 來源；後續要繼續深挖，作法是用壞 referrer/billing 金鑰跑 `npm run build && npm start` 重現。
function SectionErrorFallback(props: { message: string }, { unstable_retry }: ErrorInfo) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
      <p className="rounded bg-amber-50 p-3 text-sm text-amber-700">⚠️ {props.message}</p>
      <button
        type="button"
        className="rounded border border-amber-300 px-2 py-1 text-xs text-amber-700"
        onClick={() => unstable_retry()}
      >
        重試
      </button>
    </div>
  )
}

const SectionErrorBoundary = unstable_catchError(SectionErrorFallback)

export default SectionErrorBoundary
