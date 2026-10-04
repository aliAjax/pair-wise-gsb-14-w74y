<script setup lang="ts">
import { NConfigProvider, NMessageProvider, NTabPane, NTabs, zhCN, dateZhCN } from "naive-ui";
import { useBatchStore } from "./store";
import OverviewPanel from "./components/OverviewPanel.vue";
import DetailPanel from "./components/DetailPanel.vue";
import AuditPanel from "./components/AuditPanel.vue";

const store = useBatchStore();

function onTab(name: string) {
  store.setTab(name as "overview" | "detail" | "audit");
}
</script>

<template>
  <NConfigProvider :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <main class="app">
        <div class="shell">
          <header class="topbar">
            <div>
              <p class="eyebrow">城市出租车 · 燃油附加费联动执行批次</p>
              <h1>92号汽油备案价 → 附加费 → 计价器/告示 一体批次</h1>
              <p class="subtitle">
                备案价变化后，未确认批次立即失效重算，已生效班次保留当时快照；计价器离线留待回连，按设备号+批次号核对、重复回执不重复计入；
                全部回传一致后才切换附加费。异常设备单列，不能改写已生效结果。
              </p>
            </div>
            <div class="stack">
              <span class="tag">Vue3 + Pinia</span>
              <span class="tag">Naive UI</span>
              <span class="tag">单一事实源</span>
              <span class="tag">localStorage 持久化</span>
            </div>
          </header>

          <NTabs
            :value="store.state.activeTab"
            type="line"
            animated
            class="main-tabs"
            @update:value="onTab"
          >
            <NTabPane name="overview" tab="总览">
              <OverviewPanel v-if="store.state.activeTab === 'overview'" />
            </NTabPane>
            <NTabPane name="detail" tab="批次详情与执行">
              <DetailPanel v-if="store.state.activeTab === 'detail'" />
            </NTabPane>
            <NTabPane name="audit" tab="审计流水">
              <AuditPanel v-if="store.state.activeTab === 'audit'" />
            </NTabPane>
          </NTabs>
        </div>
      </main>
    </NMessageProvider>
  </NConfigProvider>
</template>
