import ExcelJS from 'exceljs'
import { createClient } from '@/lib/supabase/server'
import { buildItineraryRows, type ExportStop, type ExportLeg } from '@/lib/domain/exportRows'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  if (!UUID_RE.test(tripId)) return Response.json({ error: 'invalid trip id' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })

  // member-only（非 editor-only）：匯出是唯讀操作，viewer 也該能下載自己的行程表。
  // RPC 權限檢查模式引 legs/sync/route.ts:36 的 is_trip_editor 前例；false 一律 404，不洩漏行程是否存在。
  const { data: isMember } = await supabase.rpc('is_trip_member', { p_trip_id: tripId })
  if (!isMember) return Response.json({ error: 'not found' }, { status: 404 })

  const { data: trip, error: tripErr } = await supabase
    .from('trips')
    .select('title, start_date, end_date, currency')
    .eq('id', tripId)
    .maybeSingle()
  if (tripErr || !trip) return Response.json({ error: 'not found' }, { status: 404 })

  // user client（RLS 生效）；欄位與 .limit(500) 沿 page.tsx 的既有 select
  const [{ data: stopRows, error: stopsErr }, { data: legRows, error: legsErr }] = await Promise.all([
    supabase
      .from('stops')
      .select('id, name, timezone, starts_at, ends_at, estimated_cost, notes')
      .eq('trip_id', tripId)
      .order('starts_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(500),
    supabase
      .from('legs')
      .select('id, from_stop_id, to_stop_id, mode, duration_minutes, detail, source, estimated_cost')
      .eq('trip_id', tripId)
      .order('id', { ascending: true })
      .limit(500),
  ])
  if (stopsErr || legsErr) return Response.json({ error: 'read failed' }, { status: 500 })

  const rows = buildItineraryRows(trip, (stopRows ?? []) as ExportStop[], (legRows ?? []) as ExportLeg[])

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('行程表')
  sheet.columns = [
    { header: '時間', key: 'time', width: 16 },
    { header: '項目', key: 'item', width: 32 },
    { header: '分鐘', key: 'minutes', width: 8 },
    { header: `花費（${trip.currency}）`, key: 'cost', width: 14 },
    { header: '備註', key: 'notes', width: 32 },
  ]
  sheet.getRow(1).font = { bold: true }

  // 防公式注入不變量：以下所有 addRow 一律傳純字串/數字字面值，絕不傳 { formula: ... } 物件——
  // exceljs 依值型態決定 cell type，字串值落地為 inline/shared string，在 OOXML 層級就不是公式，
  // 即使停留點名稱以 = / + / - / @ 開頭（如 =HYPERLINK(...)）Excel 開啟時也不會被當公式執行
  // （不同於沒有型別資訊的 CSV 匯出，那類格式才有公式注入攻擊面）。
  for (const row of rows) {
    if (row.kind === 'day') {
      const r = sheet.addRow({ time: '', item: row.label, minutes: '', cost: '', notes: '' })
      r.font = { bold: true }
      r.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } } })
    } else if (row.kind === 'stop') {
      sheet.addRow({ time: row.time, item: row.name, minutes: row.stayMinutes, cost: row.cost ?? '', notes: row.notes ?? '' })
    } else if (row.kind === 'leg') {
      const item = `${row.modeLabel} ${row.durationText}${row.crossDay ?? ''}${row.detached ? '（已脫離順序）' : ''}`
      sheet.addRow({ time: '', item, minutes: '', cost: row.cost ?? '', notes: '' })
    } else {
      const r = sheet.addRow({ time: '', item: '總計', minutes: '', cost: row.cost, notes: '' })
      r.font = { bold: true }
    }
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      // 中文檔名走 RFC 5987 filename*=，裸 filename= 對非 ASCII 檔名行為未定義
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(trip.title)}.xlsx`,
      // 行程含花費/備註等私人資料，不得進任何共享快取（CDN/瀏覽器磁碟快取皆不行）
      'Cache-Control': 'private, no-store',
    },
  })
}
