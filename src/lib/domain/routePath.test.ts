import { describe, expect, it } from 'vitest'
import { MAX_CUSTOM_PATH_POINTS, parseCustomPath, resolveRoutePath, withEndpoints } from './routePath'

const TAIPEI = { lat: 25.0478, lng: 121.517 }
const FUKUOKA = { lat: 33.5859, lng: 130.4508 }

describe('parseCustomPath', () => {
  it('正常的 [[lat,lng],...] 轉成 LatLng 陣列', () => {
    expect(parseCustomPath([[25, 121], [26, 122]])).toEqual([
      { lat: 25, lng: 121 },
      { lat: 26, lng: 122 },
    ])
  })

  it('null／undefined／非陣列一律回空陣列', () => {
    expect(parseCustomPath(null)).toEqual([])
    expect(parseCustomPath(undefined)).toEqual([])
    expect(parseCustomPath('[[25,121]]')).toEqual([])
    expect(parseCustomPath({ 0: [25, 121] })).toEqual([])
    expect(parseCustomPath(42)).toEqual([])
  })

  // 防禦性過濾：DB 內容若損壞，個別丟棄壞元素而非整批放棄。Realtime presence 曾因信任遠端
  // 資料形狀導致整頁崩潰（spec §8 C-1），這裡從一開始就驗。
  it('個別不合法元素被丟棄，合法的保留', () => {
    const raw = [
      [25, 121], // 合法
      [25], // 長度不足
      [25, 121, 3], // 長度過長
      ['25', '121'], // 非數字
      null,
      [NaN, 121],
      [25, Infinity],
      [91, 121], // 緯度越界
      [25, 181], // 經度越界
      [-90, -180], // 邊界值合法
    ]
    expect(parseCustomPath(raw)).toEqual([
      { lat: 25, lng: 121 },
      { lat: -90, lng: -180 },
    ])
  })

  it('超過上限時截斷到 MAX_CUSTOM_PATH_POINTS', () => {
    const raw = Array.from({ length: MAX_CUSTOM_PATH_POINTS + 20 }, (_, i) => [1 + i * 0.001, 100])
    expect(parseCustomPath(raw)).toHaveLength(MAX_CUSTOM_PATH_POINTS)
  })

  it('空陣列回空陣列', () => {
    expect(parseCustomPath([])).toEqual([])
  })
})

describe('withEndpoints', () => {
  it('頭尾接上停留點目前位置', () => {
    expect(withEndpoints([{ lat: 30, lng: 125 }], TAIPEI, FUKUOKA)).toEqual([
      TAIPEI,
      { lat: 30, lng: 125 },
      FUKUOKA,
    ])
  })

  it('沒有中間點時就是兩點直線', () => {
    expect(withEndpoints([], TAIPEI, FUKUOKA)).toEqual([TAIPEI, FUKUOKA])
  })
})

describe('resolveRoutePath', () => {
  // Google 官方文件 Encoded Polyline Algorithm Format 的標準範例
  const ENCODED = '_p~iF~ps|U_ulLnnqC_mqNvxq`@'

  it('有 custom_path 時優先，且已接上頭尾停留點', () => {
    const path = resolveRoutePath(
      { custom_path: [[30, 125]], polyline: ENCODED, mode: 'transit' },
      TAIPEI,
      FUKUOKA,
    )
    expect(path).toEqual([TAIPEI, { lat: 30, lng: 125 }, FUKUOKA])
  })

  it('custom_path 為空時退回 Google 的 polyline（不接頭尾——Google 路線本身已含端點）', () => {
    const path = resolveRoutePath(
      { custom_path: null, polyline: ENCODED, mode: 'transit' },
      TAIPEI,
      FUKUOKA,
    )
    expect(path).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ])
  })

  it('custom_path 內容全部損壞時視同沒有，退回 polyline', () => {
    const path = resolveRoutePath(
      { custom_path: [['x', 'y'], [999, 999]], polyline: ENCODED, mode: 'transit' },
      TAIPEI,
      FUKUOKA,
    )
    expect(path?.[0]).toEqual({ lat: 38.5, lng: -120.2 })
  })

  it('無 custom_path 也無 polyline 時，flight 走大圓弧', () => {
    const path = resolveRoutePath(
      { custom_path: null, polyline: null, mode: 'flight' },
      TAIPEI,
      FUKUOKA,
    )
    expect(path).not.toBeNull()
    expect(path!.length).toBeGreaterThan(2)
    expect(path![0].lat).toBeCloseTo(TAIPEI.lat, 9)
    expect(path![path!.length - 1].lng).toBeCloseTo(FUKUOKA.lng, 9)
  })

  it('無 custom_path 也無 polyline 的地面段回 null（資料就是沒有路線）', () => {
    expect(
      resolveRoutePath({ custom_path: null, polyline: null, mode: 'transit' }, TAIPEI, FUKUOKA),
    ).toBeNull()
    expect(
      resolveRoutePath({ custom_path: null, polyline: null, mode: 'custom' }, TAIPEI, FUKUOKA),
    ).toBeNull()
  })

  it('手繪路徑優先於 flight 的大圓弧', () => {
    const path = resolveRoutePath(
      { custom_path: [[30, 125]], polyline: null, mode: 'flight' },
      TAIPEI,
      FUKUOKA,
    )
    expect(path).toEqual([TAIPEI, { lat: 30, lng: 125 }, FUKUOKA])
  })
})
