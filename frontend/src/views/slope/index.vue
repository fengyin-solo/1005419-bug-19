<template>
  <section class="page" data-module="slope">
    <header class="page-head">
      <div>
        <h2>边坡形变管理</h2>
        <p class="page-desc">维护边坡观测点，围绕测点编号、所属隐患点、监测方式、本期位移做登记、筛选与状态流转。状态按「待观测 → 正常 → 变形加剧 → 已停测」逐级推进，跨级与重复提交一律拦下。</p>
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
      <span class="legend-item">本期位移越界阈值：{{ displacementLimit }} mm，越界提交会被挡回</span>
      <span class="legend-item">标记加剧自动联动群测群防巡查台账，同测点只保留一条重点测点</span>
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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看明细</button>
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
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer" aria-label="观测点明细">
        <header class="drawer-head">
          <div>
            <h3>观测点明细 · {{ detail['测点编号'] }}</h3>
            <p class="page-desc">抽屉与清单读取同一份落库记录，字段与流转明细一致。</p>
          </div>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <h4 class="drawer-sub">字段信息</h4>
        <dl class="detail-grid">
          <template v-for="field in columns" :key="field">
            <dt>{{ field }}</dt>
            <dd :class="{ 'error-text': field === '形变状态' && detail.status === '变形加剧' }">
              {{ detail[field] ?? '—' }}
            </dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detail.status }}</dd>
        </dl>

        <h4 class="drawer-sub">流转明细</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>动作</th>
              <th>原状态</th>
              <th>新状态</th>
              <th>操作时间</th>
              <th>操作人</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(record, recordIndex) in detailRecords" :key="recordIndex">
              <td>{{ record.action }}</td>
              <td>{{ record.from }}</td>
              <td>{{ record.to }}</td>
              <td>{{ record.at }}</td>
              <td>{{ record.operator }}</td>
            </tr>
            <tr v-if="!detailRecords.length">
              <td colspan="5" class="empty-state">暂无流转记录</td>
            </tr>
          </tbody>
        </table>

        <div class="drawer-actions">
          <button
            v-for="action in actions"
            :key="action"
            class="btn"
            type="button"
            @click="runAction(action, detail)"
          >
            {{ action }}
          </button>
        </div>
        <p v-if="detailMessage" class="error-text">{{ detailMessage }}</p>
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
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('slope')
const columns = ["测点编号", "所属隐患点", "监测方式", "本期位移", "累计位移", "观测日期", "观测人", "形变状态"]
const actions = ["提交观测", "标记加剧", "办理停测"]
const statuses = ["待观测", "正常", "变形加剧", "已停测"]
const displacementLimit = 50
const stats = [{"label": "待观测测点", "value": 0}, {"label": "变形加剧测点", "value": 0}, {"label": "本期最大位移", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const detailId = ref<number | null>(null)
const detailMessage = ref('')
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 详情抽屉不持有独立副本：每次都按 id 回到落库的同一条测点记录读取，
// 清单与抽屉永远对得上。
const detail = computed<EntryRow | null>(() =>
  detailId.value === null ? null : getEntry(meta.key, detailId.value) ?? null,
)
const detailRecords = computed(() => detail.value?.records ?? [])

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

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
  detailMessage.value = ''
}

function closeDetail() {
  detailId.value = null
  detailMessage.value = ''
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  detailMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    if (detailId.value === Number(row.id)) {
      detailMessage.value = result.message
    }
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
