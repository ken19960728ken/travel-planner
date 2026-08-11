'use client'

import { costByCategory, costByParticipant, totalForSplit, type CategoryCostItem, type CostItem, type ParticipantCostItem } from '@/lib/domain/cost'
import { CATEGORY_ORDER, CATEGORY_LABEL } from '@/lib/domain/placeCategory'
import type { Participant } from '@/lib/domain/participants'
import ParticipantChip from './ParticipantChip'

/** 分類花費摘要（Plan 7 D5）：六個停留點分類桶 + 獨立的「交通段」桶。
 *  純展示元件——不抓資料、不持有 state、不做圖表；所有數字由 costByCategory 一次算完。
 *  金額為 0 的桶不顯示，避免空行稀釋資訊（全空時整個區塊不渲染）。
 *  TODO(Plan 7 Task 3)：categoryUi.ts 合併後可在標籤前加 CATEGORY_ICON 的 emoji。 */
export default function CostSummary({
  stops,
  legs,
  currency,
  roster,
  participantItems,
}: {
  stops: readonly CategoryCostItem[]
  legs: readonly CostItem[]
  currency: string
  /** 參與人名冊；為空時不顯示「每人應付」區塊 */
  roster: readonly Participant[]
  /** 分帳用的項目（停留點＋交通段，交通段的參與人已由呼叫端取前後交集） */
  participantItems: readonly ParticipantCostItem[]
}) {
  const { byCategory, legs: legsTotal, total } = costByCategory(stops, legs)
  const perParticipant = costByParticipant(participantItems, roster.map(p => p.id))
  // 每人應付的基底必須與它自己的總額一致（審查 M-4）：costByCategory 的 total 是原始浮點加總，
  // 與分攤用的最小單位基底可能差幾分。並列顯示時取自同一份 totalForSplit，
  // 否則使用者會看到「明細加不回總計」。
  const splitTotal = totalForSplit(participantItems)
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
        {/* 每人應付：每筆花費只分攤給該項目的參與人。不變量（cost.test.ts）是在**最小單位**上
            成立——這幾列加起來等於 splitTotal。splitTotal 與上面的「總計」在有小數金額時可能
            差幾分（前者以分為單位重算、後者是原始浮點加總），故不同時，另外標示出來。 */}
        {roster.length > 0 && splitTotal !== total && (
          <li className="flex justify-between gap-2 text-xs text-gray-400">
            <span>分帳基準（四捨五入到最小單位）</span>
            <span className="tabular-nums">{currency} {splitTotal}</span>
          </li>
        )}
        {roster.length > 0 && roster.map(p => (
          <li key={p.id} className="flex justify-between gap-2 text-gray-600">
            <span className="flex items-center gap-1">
              <ParticipantChip participant={p} size={16} />
              {p.name}
            </span>
            <span className="tabular-nums">{currency} {perParticipant[p.id] ?? 0}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}
