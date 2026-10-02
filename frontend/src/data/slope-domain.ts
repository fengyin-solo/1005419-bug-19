import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryEvent, EntryRow } from '@/data/types'

// 边坡本期位移的合法量程：单位 mm。超出量程视为仪器或录入异常，挡回不许提交。
export const SLOPE_DISPLACEMENT_MIN = 0
export const SLOPE_DISPLACEMENT_MAX = 100

/** 边坡模块键名：台账联动（群测群防巡查）只认这一份。 */
export const SLOPE_KEY = 'slope'
export const PATROL_KEY = 'patrol'

/** 巡查台账里「重点测点」联动行的标记字段，两处口径对接全靠它。 */
export const PATROL_KEY_POINT_FLAG = '重点测点'
export const PATROL_MONITOR_FIELD = '监测方式'

/** 解析本期位移：返回 null 表示不是有效数值（空值、非数字都算）。 */
export function parseDisplacement(value: string | number | boolean | EntryEvent[] | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }
  const parsed = Number(value.replace(/[毫米\s]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

/** 本期位移是否越界：有效数值落在 [0, 100] 量程之外才算越界。 */
export function isDisplacementOutOfRange(value: string | number | boolean | EntryEvent[] | undefined): boolean {
  const parsed = parseDisplacement(value)
  return parsed !== null && (parsed < SLOPE_DISPLACEMENT_MIN || parsed > SLOPE_DISPLACEMENT_MAX)
}

/** 提交观测前的业务校验：本期位移必须是量程内的有效数值。 */
export function validateSlopeSubmit(row: EntryRow): ActionResult | null {
  const raw = row['本期位移']
  const parsed = parseDisplacement(raw)
  if (parsed === null) {
    return { ok: false, message: '边坡观测点本期位移缺少有效数值，请补测后再提交观测' }
  }
  if (parsed < SLOPE_DISPLACEMENT_MIN || parsed > SLOPE_DISPLACEMENT_MAX) {
    return {
      ok: false,
      message: `边坡观测点本期位移 ${parsed}mm 越出量程（${SLOPE_DISPLACEMENT_MIN}~${SLOPE_DISPLACEMENT_MAX}mm），已挡回，请复核仪器读数后重报`,
    }
  }
  return null
}

/** 边坡观测点的异常口径：标记加剧（变形加剧）才算异常。 */
export function isSlopeAbnormal(target: string): boolean {
  return target === '变形加剧'
}

function nowStamp(): string {
  return new Date().toISOString()
}

/**
 * 标记加剧收尾：结论驱动群测群防巡查台账，按测点编号 upsert 一条重点测点。
 * 同一测点编号反复提交只更新同一条台账行，绝不叠加新行。
 */
export function syncPatrolKeyPoint(point: EntryRow): void {
  const code = String(point['测点编号'] ?? '')
  const monitorMethod = String(point[PATROL_MONITOR_FIELD] ?? '')
  const patrolRows = listRows(PATROL_KEY)
  const index = patrolRows.findIndex(
    (row) => row[PATROL_KEY_POINT_FLAG] === true && String(row['测点编号'] ?? '') === code,
  )
  const stamp = nowStamp()
  const common = {
    巡查编号: `KP-${code}`,
    所属隐患点: point['所属隐患点'] ?? '',
    巡查人: point['观测人'] ?? '',
    巡查日期: stamp.slice(0, 10),
    坡面情况: `重点测点：边坡观测点 ${code} 已标记变形加剧`,
    排水情况: '—',
    巡查结论: `重点测点：${code} 变形加剧（监测方式：${monitorMethod || '—'}），列入群测群防重点巡查`,
    巡查状态: '发现异常',
    测点编号: code,
    [PATROL_MONITOR_FIELD]: monitorMethod,
    [PATROL_KEY_POINT_FLAG]: true as const,
  }
  if (index >= 0) {
    patrolRows[index] = { ...patrolRows[index], ...common }
  } else {
    patrolRows.push({
      id: patrolRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
      status: '发现异常',
      pending: false,
      abnormal: true,
      ...common,
    })
  }
  saveRows(PATROL_KEY, patrolRows)
}

/** 群测群防巡查读到的监测方式：以边坡形变台账为唯一口径，重点测点回查测点原记录。 */
export function resolveMonitorMethod(patrolRow: EntryRow): string {
  if (patrolRow[PATROL_KEY_POINT_FLAG] !== true) {
    return '—'
  }
  const code = String(patrolRow['测点编号'] ?? '')
  const point = listRows(SLOPE_KEY).find((row) => String(row['测点编号'] ?? '') === code)
  if (!point) {
    return String(patrolRow[PATROL_MONITOR_FIELD] ?? '') || '—'
  }
  return String(point[PATROL_MONITOR_FIELD] ?? '') || '—'
}

/** 往测点记录的明细里按事件 id 合入一条流转记录：重复提交不产生重复明细。 */
export function upsertEvent(events: EntryEvent[] | undefined, event: EntryEvent): EntryEvent[] {
  const list = events ?? []
  const index = list.findIndex((item) => item.id === event.id)
  if (index >= 0) {
    const next = [...list]
    next[index] = { ...list[index], ...event }
    return next
  }
  return [...list, event]
}
