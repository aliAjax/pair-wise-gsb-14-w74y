# 城市出租车燃油附加费 · 联动执行批次

92号汽油备案价与出租车燃油附加费联动的最小闭环控制台：**备案价变化 → 未确认批次立即失效重算 → 计价器/乘客告示全部回传一致 → 才切换附加费**；已生效班次保留当时快照，异常设备单列且不得改写已生效结果。

- 技术栈：Vue 3 + Vite + TypeScript + Pinia
- 启动：`npm install && npm run dev`
- 构建：`npm run build`
- 规则自测：`npm test`（覆盖失效重算、离线回连核对、重复回执幂等、全一致才切换、异常单列、双运营员先到者、失败完整重试、快照班次、补档待核、三页同结论）

## 执行规则到实现的对应

| 业务规则 | 实现 |
| --- | --- |
| 备案价变化，未确认批次立即失效重算 | `cmdRegisterFiling` 追加 `BatchCreated` + `BatchInvalidated`，旧批次回执计数清空不沿用 |
| 已生效班次保留当时快照 | `BatchActivated` 固化快照并把旧生效批次转为 `retired`（回执/快照保留，只读）；`cmdSettleShift` 引用生效批次的快照 |
| 计价器离线留待回传，回连按设备号+批次号核对 | `cmdAcceptReceipt` 校验 `checksum(批次,设备)`，UI 对离线设备提供「回连回传」 |
| 重复回执不重复计入 | 同 `receiptId` 重发幂等成功只入审计；同设备不同回执列异常 |
| 全部计价器和告示回传一致才切换 | `readinessOf`：5 计价器 + 2 告示齐、无隔离、补档非待核，`cmdPublish` 否则失败 |
| 异常设备单列，不能改写已生效结果 | `DeviceQuarantined` 叠加异常台账（保留回执证据）；active/retired 批次的回传/恢复一律拒绝 |
| 两名运营员只放行先到者 | `cmdClaimPublish` 先到者持锁，后到者 `PublishRejected`，仅持锁人可发布 |
| 失败后从完整批次重试 | `simulateFailure` 追加 `PublishFailed` 释放锁，不产生部分生效，完整批次可重新抢占发布 |
| 旧附加费按生效日补档，补不全停在待核 | 旧系统迁移班次（`LegacyShiftImported`）缺档；补档登记（`retroactive`）不重算执行批次，能按生效日补即补，否则 `held` 阻断切换 |
| 总览、详情、审计同一结论 | 单一事件日志经 `fold` 折叠为唯一 State，`buildModel` 产出唯一 `conclusion`，三个页签共用 |

所有状态变更只追加事件（`src/domain/`），UI 仅做演示驱动；数据持久化在浏览器 localStorage。
