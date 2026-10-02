/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/** 状态流转记录：每次成功推进只追加一条，同一测点重复提交被拦下，不会叠加。 */
export type FlowRecord = {
  action: string
  from: string
  to: string
  at: string
  operator: string
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  records?: FlowRecord[]
  [field: string]: string | number | boolean | FlowRecord[] | undefined
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
