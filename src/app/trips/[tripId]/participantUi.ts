/** 參與人的識別樣式（設計文件 docs/superpowers/specs/2026-08-11-participants-design.md §5.3）。
 *
 *  【為何識別主體是首字而不是顏色】選色度量沿 categoryUi.ts:36-39 的 CIE ΔE（**不用 WCAG
 *  對比度**——那衡量明暗差，設計目的是文字可讀性；青與綠亮度幾乎相同卻一眼可辨）。
 *  對既有 19 個保留色（categoryUi 六個分類桶 + RoutePolylines 五個模式色 + 選取/當日/他日/
 *  草稿針/選中備選/播放頭/紅線/步行灰）做全配對掃描並**窮舉**最佳子集，可達的最小 ΔE：
 *
 *      4 色 28.8（一眼可辨）  5 色 26.1  6 色 23.7（需留意）  8 色 20.6（需留意）
 *
 *  窮舉已確認這是上限，不是搜尋不力。更關鍵的是 5 色最佳解的內容——lime-500、green-500、
 *  lime-700、teal-700 加 fuchsia-500，**四個綠色系**，因為紅藍紫橘粉全被保留色佔走了。
 *  ΔE 26 在數字上「可辨」，讀起來卻是「深淺不同的綠」，不是四個不同的人。
 *
 *  故：首字是主要識別（不吃 ΔE 預算、20 人都能區分、不需常駐圖例），顏色只做輔助分組。
 *
 *  ⚠️ 新增顏色或新增保留色前必須重跑掃描——保留色一旦增加，這四色的 ΔE 也會跟著變。 */

/** 對保留色與彼此的最小 ΔE ＝ 28.8。順序即指派順序。 */
export const PARTICIPANT_COLORS: readonly string[] = [
  '#84cc16', // lime-500
  '#22c55e', // green-500
  '#d946ef', // fuchsia-500
  '#4d7c0f', // lime-700
]

/** 依名冊順序指派顏色，超過四人循環（首字仍可區分，見檔頭）。
 *  取絕對值再取餘：負索引在 JS 的 % 會得到負數而讓查表回 undefined，圖示會整個沒有底色。 */
export function participantColorAt(index: number): string {
  return PARTICIPANT_COLORS[Math.abs(Math.trunc(index)) % PARTICIPANT_COLORS.length]
}

/** 播放圖示與側欄圖章上的字。
 *  用 Array.from 取第一個**碼位**而非 charAt——後者會把 emoji 這類代理對截半成亂碼方框。 */
export function participantInitial(name: string): string {
  return Array.from(name.trim())[0] ?? '?'
}

/** 多人同點時的合併圖示底色，刻意不屬於任何參與人——用某個人的顏色會讓人以為那一群裡只有他。
 *
 *  對全部保留色與四個參與人色的最小 ΔE ＝ **34.9**（瓶頸是草稿針 #9ca3af）。
 *  第一版用 slate-700 #334155，實測對 custom 模式色 #1e293b 只有 ΔE 10.8（「難分辨」）——
 *  深色中性帶已被 custom/other/步行灰三個保留色佔滿，合併圖示只能往淺色走。
 *  故採淺紫 + 深色數字，而非「深底白字」。
 *
 *  ⚠️ 這個值本身也是保留色，未來掃描新配色時要把它一起算進去。 */
export const MERGED_MARKER_COLOR = '#c4b5fd'

/** 合併圖示的數字顏色。底色是淺紫，必須用深色字。 */
export const MERGED_MARKER_TEXT = '#1e1b4b'
