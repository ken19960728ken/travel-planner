'use client'

import { unstable_catchError, type ErrorInfo } from 'next/error'

// Maps 金鑰驗證失敗（如 referrer 不符）時，vis.gl 內部在降級畫面渲染前會先丟出一個未捕捉的
// TypeError，若不接住會把整個行程頁的 React tree 打崩。只包住地圖區塊，讓側欄與時間軸不受影響。
// 固定文案不需要用到 props/errorInfo，但 unstable_catchError 要靠這兩個具名參數的型別標註才能
// 正確推斷 P（無 props 時的合法用法）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function MapErrorFallback(_props: object, _errorInfo: ErrorInfo) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <p className="rounded bg-amber-50 p-3 text-sm text-amber-700">
        ⚠️ 地圖載入失敗（可能是金鑰或網路問題），行程資料仍可正常編輯
      </p>
    </div>
  )
}

const MapErrorBoundary = unstable_catchError(MapErrorFallback)

export default MapErrorBoundary
