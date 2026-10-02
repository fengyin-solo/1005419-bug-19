import { MODULE_BY_KEY } from '@/data/modules'
import {
  isSlopeAbnormal,
  SLOPE_KEY,
  syncPatrolKeyPoint,
  upsertEvent,
  validateSlopeSubmit,
} from '@/data/slope-domain'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
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

/** 清单、详情、导出统一从这里读同一条测点记录，绝不各取一份。 */
export function getEntry(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
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
  const currentRow = rows[index]
  const current = String(currentRow.status)

  // 同一测点反复提交同一结论：直接拦回，明细和联动台账都不会叠加。
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，结果不重复叠加` }
  }

  // 状态只能按登记次序逐级推进；模块为某状态显式登记过规则时，以该规则为准（空列=终态），
  // 个别模块的旁路（取消、误报、驳回等）在规则内放行，其余跨级一律拦下。
  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)
  const rules = meta.allowedTransitions
  const hasRule = rules ? Object.prototype.hasOwnProperty.call(rules, current) : false
  const moveAllowed = hasRule
    ? (rules![current] ?? []).includes(target)
    : targetIndex === currentIndex + 1
  if (!moveAllowed) {
    return {
      ok: false,
      message: `${meta.entity}状态只能逐级推进：「${current}」不能直接跳到「${target}」，该跨级操作已拦下`,
    }
  }

  // 模块自带的提交前校验（边坡：本期位移越界值挡回）。
  if (key === SLOPE_KEY && action === '提交观测') {
    const violation = validateSlopeSubmit(currentRow)
    if (violation) {
      return violation
    }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const abnormal =
    key === SLOPE_KEY ? isSlopeAbnormal(target) : NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
  const statusField = meta.fields[meta.fields.length - 1]
  // 状态字段（形变状态等）与 status 一次性写全、一次落库，页面与落库那份不再两张皮。
  const updated: EntryRow = {
    ...currentRow,
    status: target,
    [statusField]: target,
    pending: target !== lastStatus,
    abnormal,
  }
  updated.events = upsertEvent(currentRow.events, {
    id: `${currentRow.id}:${action}`,
    action,
    from: current,
    to: target,
    time: new Date().toISOString(),
    operator: '值班管理员',
  })
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)

  // 标记加剧收尾：结论同步群测群防巡查台账（按测点编号幂等 upsert 一条重点测点）。
  if (key === SLOPE_KEY && action === '标记加剧') {
    syncPatrolKeyPoint(updated)
  }
  return { ok: true, message: `${meta.entity}已${action}，结论已落库，当前状态「${target}」` }
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
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
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
