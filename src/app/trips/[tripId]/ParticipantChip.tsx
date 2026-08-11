import type { Participant } from '@/lib/domain/participants'
import { participantInitial } from './participantUi'

/** 參與人的首字圖章。名冊面板、側欄停留點列、地圖播放圖示三處共用同一個外觀——
 *  使用者要能一眼把「地圖上那個綠色的『明』」對應回「側欄那個綠色的『明』」，
 *  三處各畫各的遲早會漂移。
 *
 *  title 帶完整名字：兩個人首字相同時（設計文件 §10 允許）這是唯一的區分方式。 */
export default function ParticipantChip({
  participant,
  size = 20,
}: {
  participant: Participant
  size?: number
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{
        backgroundColor: participant.color,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        // 淺色底（例如 lime-500）配白字對比不足，加一圈深色描邊讓字在任何底色上都讀得出來
        textShadow: '0 0 2px rgba(0,0,0,0.6)',
      }}
      title={participant.name}
    >
      {participantInitial(participant.name)}
    </span>
  )
}
