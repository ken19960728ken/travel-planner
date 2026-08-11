import { describe, it, expect } from 'vitest'
import { PARTICIPANT_COLORS, participantColorAt, participantInitial } from './participantUi'

describe('participantColorAt', () => {
  it('依索引取色，超過色盤長度循環', () => {
    expect(participantColorAt(0)).toBe(PARTICIPANT_COLORS[0])
    expect(participantColorAt(PARTICIPANT_COLORS.length)).toBe(PARTICIPANT_COLORS[0])
    expect(participantColorAt(PARTICIPANT_COLORS.length + 1)).toBe(PARTICIPANT_COLORS[1])
  })

  it('負索引不回傳 undefined（防禦性：呼叫端算錯索引不該讓圖示變透明）', () => {
    expect(PARTICIPANT_COLORS).toContain(participantColorAt(-1))
  })
})

describe('participantInitial', () => {
  it('取名稱第一個字元', () => {
    expect(participantInitial('小明')).toBe('小')
    expect(participantInitial('Ken')).toBe('K')
  })

  it('前後空白不算字元', () => {
    expect(participantInitial('  阿姨  ')).toBe('阿')
  })

  it('emoji 等代理對不被截半（用 Array.from 而非 charAt）', () => {
    expect(participantInitial('🐻小熊')).toBe('🐻')
  })

  it('空字串或全空白回退為 ?', () => {
    expect(participantInitial('')).toBe('?')
    expect(participantInitial('   ')).toBe('?')
  })
})

describe('色盤本身', () => {
  it('四色互不重複', () => {
    expect(new Set(PARTICIPANT_COLORS).size).toBe(PARTICIPANT_COLORS.length)
  })

  it('全部是 #rrggbb 格式（DB constraint 與 SVG fill 都預期這個形狀）', () => {
    for (const c of PARTICIPANT_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })
})
