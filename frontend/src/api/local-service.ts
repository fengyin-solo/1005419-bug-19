import { useSessionStore } from '@/stores/session'

import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  FlowRecord,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 边坡观测点：本期位移允许范围（毫米）。越界值不允许按「正常」提交观测，
// 应先按现场结论走「标记加剧」。
const SLOPE_KEY = 'slope'
const SLOPE_DISPLACEMENT_LIMIT = 50
// 标记加剧要联动的群测群防巡查台账模块。
const PATROL_KEY = 'patrol'
// 口径优先级：边坡观测点记录是权威源，台账的监测方式等一律从观测点同步。
const PATROL_POINT_FIELD = '测点编号'
const PATROL_METHOD_FIELD = '监测方式'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// 字段列里的业务状态字段（如「形变状态」「巡查状态」）。它与内部 status 必须同写同读，
// 否则页面显示一份、落库一份，重开就会跳回旧值。
function statusFieldOf(meta: ModuleMeta): string | undefined {
  return [...meta.fields].reverse().find((field) => field.endsWith('状态'))
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 清单与详情抽屉共用这一个读入口：始终以落库的同一份测点记录为准。
export function getEntry(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

function nowLabel(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

function currentOperator(): string {
  try {
    return useSessionStore().operator || '值班管理员'
  } catch {
    return '值班管理员'
  }
}

// 本期位移：只接受不越界的有限数值。空值、非数值、负数、超阈值一律挡回。
function parseDisplacement(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  const text = String(value ?? '').trim()
  if (text === '') {
    return undefined
  }
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

// 提交收尾（边坡「提交观测」）的专项校验：本期位移给出越界值的那几条挑出来挡回。
function validateSubmit(key: string, meta: ModuleMeta, action: string, row: EntryRow): string | null {
  if (key !== SLOPE_KEY || meta.actionTargets[action] !== meta.statuses[1]) {
    return null
  }
  const displacement = parseDisplacement(row['本期位移'])
  if (displacement === undefined) {
    return `测点 ${String(row['测点编号'] ?? '')} 的本期位移不是有效数值，无法提交观测，请先补测登记`
  }
  if (displacement < 0) {
    return `测点 ${String(row['测点编号'] ?? '')} 的本期位移不能为负（${displacement} mm），请核对后再提交`
  }
  if (displacement > SLOPE_DISPLACEMENT_LIMIT) {
    return (
      `测点 ${String(row['测点编号'] ?? '')} 的本期位移 ${displacement} mm 已越界` +
      `（阈值 ${SLOPE_DISPLACEMENT_LIMIT} mm），不能提交为「正常」，请按「标记加剧」处理`
    )
  }
  return null
}

// 标记加剧收尾后驱动群测群防巡查台账：同一测点编号只保留一条重点测点，反复提交不叠加。
// 台账里的监测方式等信息以边坡观测点记录为准（权威源），冲突时覆盖台账旧值。
function syncPatrolLedger(point: EntryRow, record: FlowRecord): void {
  const rows = [...listRows(PATROL_KEY)]
  const pointCode = String(point['测点编号'] ?? '')
  const existingIndex = rows.findIndex((row) => String(row[PATROL_POINT_FIELD] ?? '') === pointCode)
  const conclusion = `重点测点 ${pointCode} 边坡观测点标记为变形加剧，请加密巡查频次`
  const baseFields: EntryRow = {
    id: 0,
    status: '发现异常',
    pending: false,
    abnormal: true,
    巡查编号: '',
    所属隐患点: String(point['所属隐患点'] ?? ''),
    巡查人: record.operator,
    巡查日期: record.at.slice(0, 10),
    坡面情况: `${pointCode} 变形加剧，列为重点测点`,
    排水情况: '现场复核',
    巡查结论: conclusion,
    巡查状态: '发现异常',
    [PATROL_POINT_FIELD]: pointCode,
    // 监测方式两处读到的必须一致：直接取观测点记录上的值。
    [PATROL_METHOD_FIELD]: String(point[PATROL_METHOD_FIELD] ?? ''),
    records: [],
  }
  if (existingIndex >= 0) {
    const existing = rows[existingIndex]
    rows[existingIndex] = {
      ...existing,
      ...baseFields,
      id: existing.id,
      巡查编号: existing['巡查编号'],
      records: [...(existing.records ?? []), record],
    }
    saveRows(PATROL_KEY, rows)
    return
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  rows.push({
    ...baseFields,
    id: nextId,
    巡查编号: `PATR-${String(nextId).padStart(4, '0')}`,
    records: [record],
  })
  saveRows(PATROL_KEY, rows)
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  const row = rows[index]
  const current = String(row.status)

  // 同一测点反复提交同一个结论：幂等拦下，不新增流转记录、不叠加台账。
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 状态严格按 待观测 → 正常 → 变形加剧 → 已停测（各模块同理）逐级推进，跨级一律拦下。
  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)
  if (currentIndex < 0 || targetIndex < 0) {
    return { ok: false, message: `${meta.entity}当前状态「${current}」不在登记的状态次序内` }
  }
  if (targetIndex <= currentIndex) {
    return { ok: false, message: `${meta.entity}已处于「${current}」，状态不能回退到「${target}」` }
  }
  if (targetIndex !== currentIndex + 1) {
    return {
      ok: false,
      message: `状态只能按「${meta.statuses.join(' → ')}」逐级推进，不能从「${current}」跨到「${target}」`,
    }
  }

  // 提交收尾前的业务校验（如本期位移越界挡回）。
  const invalid = validateSubmit(key, meta, action, row)
  if (invalid) {
    return { ok: false, message: invalid }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const statusField = statusFieldOf(meta)
  // 字段一次性写全：内部 status、字段列里的业务状态字段、pending/abnormal、流转记录同源同值，
  // 标记加剧的结论不再只停在页面上。
  const record: FlowRecord = {
    action,
    from: current,
    to: target,
    at: nowLabel(),
    operator: currentOperator(),
  }
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== lastStatus,
    abnormal:
      NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)) ||
      (key === SLOPE_KEY && target === '变形加剧'),
    records: [...(row.records ?? []), record],
  }
  if (statusField) {
    updated[statusField] = target
  }

  const next = [...rows]
  next[index] = updated
  saveRows(key, next)

  // 边坡标记加剧：提交收尾结果驱动群测群防巡查台账（重点测点，同测点只一条）。
  if (key === SLOPE_KEY && target === '变形加剧') {
    syncPatrolLedger(updated, record)
  }

  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
