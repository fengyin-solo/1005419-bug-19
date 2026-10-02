/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/** 同一条测点记录上的流转明细：一次状态推进写一条，按 id 去重，反复提交不叠加。 */
export type EntryEvent = {
  id: string
  action: string
  from: string
  to: string
  time: string
  operator: string
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  events?: EntryEvent[]
  [field: string]: string | number | boolean | EntryEvent[] | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /**
   * 允许的状态推进（from -> to）。缺省即「按 statuses 次序逐级推进」；
   * 个别模块存在取消、误报这类旁路动作，在这里显式放行，其余跨级一律拦下。
   */
  allowedTransitions?: Record<string, string[]>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
