'use client'

import { costByCategory, type CategoryCostItem, type CostItem } from '@/lib/domain/cost'
import { CATEGORY_ORDER, CATEGORY_LABEL } from '@/lib/domain/placeCategory'

/** 分類花費摘要（Plan 7 D5）：六個停留點分類桶 + 獨立的「交通段」桶。
 *  純展示元件——不抓資料、不持有 state、不做圖表；所有數字由 costByCategory 一次算完。
 *  金額為 0 的桶不顯示，避免空行稀釋資訊（全空時整個區塊不渲染）。
 *  TODO(Plan 7 Task 3)：categoryUi.ts 合併後可在標籤前加 CATEGORY_ICON 的 emoji。 */
export default function CostSummary({
  stops,
  legs,
  currency,
}: {
  stops: readonly CategoryCostItem[]
  legs: readonly CostItem[]
  currency: string
}) {
  const { byCategory, legs: legsTotal, total } = costByCategory(stops, legs)
  if (total === 0) return null

  const rows: { label: string; amount: number }[] = [
    ...CATEGORY_ORDER.filter(c => byCategory[c] > 0).map(c => ({
      label: CATEGORY_LABEL[c],
      amount: byCategory[c],
    })),
    ...(legsTotal > 0 ? [{ label: '交通段', amount: legsTotal }] : []),
  ]

  return (
    <details className="mt-2 rounded border p-2">
      <summary className="cursor-pointer text-sm font-medium">
        花費分類（{currency} {total}）
      </summary>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {rows.map(r => (
          <li key={r.label} className="flex justify-between gap-2">
            <span className="text-gray-600">{r.label}</span>
            <span className="tabular-nums">{currency} {r.amount}</span>
          </li>
        ))}
        <li className="mt-1 flex justify-between gap-2 border-t pt-1 font-medium">
          <span>總計</span>
          <span className="tabular-nums">{currency} {total}</span>
        </li>
      </ul>
    </details>
  )
}
