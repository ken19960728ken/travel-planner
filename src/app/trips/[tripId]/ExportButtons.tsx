'use client'

/** 行程匯出入口（header 掛載）。本 Task 只放 Excel 下載；JSON 匯出／出發！定稿鈕於 Task 3 加入。 */
export default function ExportButtons({ tripId }: { tripId: string }) {
  return (
    <div className="ml-auto flex items-center gap-2">
      <a
        href={`/api/trips/${tripId}/export/xlsx`}
        className="rounded border px-2 py-1 text-sm"
      >
        下載 Excel
      </a>
    </div>
  )
}
