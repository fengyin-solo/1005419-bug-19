<template>
  <section class="page" data-module="slope">
    <header class="page-head">
      <div>
        <h2>边坡形变管理</h2>
        <p class="page-desc">维护边坡观测点，围绕测点编号、所属隐患点、监测方式、本期位移做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记边坡观测点</button>
        <button class="btn" type="button" @click="exportRows">导出边坡形变清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '本期位移'">
              {{ row[column] ?? '—' }}
              <span v-if="outOfRange(row)" class="tag tag-danger">越界</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无边坡形变数据，可先登记边坡观测点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条边坡形变记录</span>
      <span>状态按 待观测 → 正常 → 变形加剧 → 已停测 逐级推进，跨级操作会被拦下；本期位移量程 {{ rangeText }}，越界值挡回</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detailRow" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer" role="dialog" aria-label="边坡观测点详情">
        <header class="drawer-head">
          <h3>边坡观测点详情</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <template v-for="field in columns" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ detailRow[field] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detailRow.status }}</dd>
        </dl>
        <h4 class="detail-sub">流转明细</h4>
        <ul class="event-list">
          <li v-for="event in detailEvents" :key="event.id" class="event-item">
            <span class="event-time">{{ formatTime(event.time) }}</span>
            <span class="event-flow">{{ event.from }} → {{ event.to }}</span>
            <span class="event-action">{{ event.action }}</span>
            <span class="event-operator">{{ event.operator }}</span>
          </li>
          <li v-if="!detailEvents.length" class="empty-state">暂无流转明细</li>
        </ul>
        <p class="drawer-note">
          清单与本抽屉读的是同一条测点记录；同一动作重复提交不叠加明细；监测方式以边坡形变台账为准。
        </p>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  isDisplacementOutOfRange,
  parseDisplacement,
  SLOPE_DISPLACEMENT_MAX,
  SLOPE_DISPLACEMENT_MIN,
} from '@/data/slope-domain'
import type { EntryEvent, EntryRow } from '@/data/types'

const meta = moduleMeta('slope')
const columns = ["测点编号", "所属隐患点", "监测方式", "本期位移", "累计位移", "观测日期", "观测人", "形变状态"]
const actions = ["提交观测", "标记加剧", "办理停测"]
const statuses = ["待观测", "正常", "变形加剧", "已停测"]
const rangeText = `${SLOPE_DISPLACEMENT_MIN}~${SLOPE_DISPLACEMENT_MAX}mm`

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const displacements = rows.value
    .map((row) => parseDisplacement(row['本期位移']))
    .filter((value): value is number => value !== null)
  return [
    { label: '待观测测点', value: rows.value.filter((row) => String(row.status) === '待观测').length },
    { label: '变形加剧测点', value: rows.value.filter((row) => String(row.status) === '变形加剧').length },
    { label: '本期最大位移(mm)', value: displacements.length ? Math.max(...displacements) : 0 },
  ]
})

const detailId = ref<number | null>(null)
// 详情抽屉每次都回数据层取同一条测点记录，与清单完全同源。
const detailRow = computed(() => (detailId.value === null ? undefined : getEntry(meta.key, detailId.value)))
const detailEvents = computed<EntryEvent[]>(() => detailRow.value?.events ?? [])

function outOfRange(row: EntryRow): boolean {
  return isDisplacementOutOfRange(row['本期位移'])
}

function formatTime(value: string): string {
  return value.replace('T', ' ').slice(0, 16)
}

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
}

function closeDetail() {
  detailId.value = null
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '边坡观测点登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '边坡形变列表读取失败'
  }
}

onMounted(reload)
</script>
