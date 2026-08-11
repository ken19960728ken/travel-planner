'use client'

import type { Participant } from '@/lib/domain/participants'
import ParticipantChip from './ParticipantChip'

/** 停留點的參與人多選。
 *
 *  【「全員」是獨立選項，不是「全部勾選」】兩者在 DB 是不同的值（null vs 完整陣列），語義也不同：
 *  「全員」意思是「之後加入名冊的人也自動包含」，而「全部勾選」是當下這幾個人的快照。
 *  共同行程幾乎都該是前者——不然每加一個旅伴就要回頭重勾所有停留點。
 *
 *  【不允許取消到 0 人】DB 的 stops_participant_ids_shape 禁止空陣列（一種語義一種表示），
 *  所以這裡必須擋，否則使用者按到最後一個會拿到看不懂的 23514。 */
export default function ParticipantPicker({
  roster,
  value,
  onChange,
  disabled = false,
}: {
  roster: readonly Participant[]
  /** null ＝ 全員 */
  value: string[] | null
  onChange: (next: string[] | null) => void
  disabled?: boolean
}) {
  if (roster.length === 0) return null

  // ⚠️ 先正規化再做任何判斷（審查 M-7）。value 可能含名冊裡已不存在的 id——協作者在編輯器
  // 開著時移除某人就會這樣，而 StopEditor 刻意保留 state 裡的未知 id（不在掛載時靜默改寫指派）。
  // 不正規化的後果實測有二：
  //   (a) value=['丙'（已移除）] 時勾「甲」→ next 長度 2 === roster 長度 2 → 收斂成 null，
  //       使用者只勾了甲，結果變成「全員」；
  //   (b) lastOne 用 selected.size 判斷，value=['丙','甲'] 時 size 為 2 → 甲的核取方塊不 disabled
  //       → 取消它得到 ['丙']（過得了長度守衛）→ 寫進 DB → resolveStopParticipants 判「全部無效
  //       → 全員」。使用者以為取消了所有人，實際是全員都去。
  // 正規化後「所有指派都失效」在 UI 上直接顯示成「全員」，與 resolveStopParticipants 的解讀
  // 一致——三層守衛不再各說各話。
  const rosterIds = roster.map(p => p.id)
  const known = value === null ? null : value.filter(id => rosterIds.includes(id))
  const effective = known === null || known.length === 0 ? null : known

  const everyone = effective === null
  const selected = new Set(effective ?? [])

  function toggle(id: string) {
    // 從「全員」取消掉一個人：先展開成完整名單再拿掉他
    const base = effective ?? rosterIds
    const next = base.includes(id) ? base.filter(x => x !== id) : [...base, id]
    if (next.length === 0) return // 至少一人；UI 上該核取方塊已 disabled，這是第二道防線
    // 展開後剛好等於全體時收斂回 null——避免產生「當下等於全員但不會跟著名冊成長」的快照
    onChange(next.length === rosterIds.length ? null : next)
  }

  return (
    <fieldset className="flex flex-col gap-1 rounded border p-1">
      <legend className="px-1 text-xs text-gray-500">誰會去</legend>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={everyone}
          disabled={disabled}
          onChange={e => onChange(e.target.checked ? null : rosterIds)}
        />
        <span className="text-sm">全員（之後加入的人也算）</span>
      </label>
      {!everyone && (
        <div className="flex flex-wrap gap-2 pl-5">
          {roster.map(p => {
            const checked = selected.has(p.id)
            const lastOne = checked && selected.size === 1
            return (
              <label
                key={p.id}
                className="flex items-center gap-1"
                title={lastOne ? '至少要有一位參與人，或改選「全員」' : p.name}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || lastOne}
                  onChange={() => toggle(p.id)}
                />
                <ParticipantChip participant={p} size={18} />
                <span className="text-sm">{p.name}</span>
              </label>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}
