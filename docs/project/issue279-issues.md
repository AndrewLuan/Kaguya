---
title: 持续 Agent 实施 issue 映射与草稿
description: issue 279 的已有追踪、六个已发布实施 issue 及待更新的 Lifecycle 正文。
---

# 持续 Agent 实施 issue 映射与草稿

本页承接[实施台账](./issue279-implementation)。六个实施 issue 已发布为 #299–#304，以下保留经审查的紧凑正文与编号映射。#193 更新返回 403，现有标题、正文和状态均保持，待有权限维护者采用末节草稿；其他已有 issue 状态保持。各工作包推进时再细化接口。所有草稿沿用台账的公共验收、迁移/回退、最新 head CI 和 PR 审查门槛。

## 已有 issue 映射

- **W0 → [#279](https://github.com/posanbu/Kaguya/issues/279)** — 总入口继续追踪九项交付及当前路线，不新建重复总纲。
- **W1 → [#247](https://github.com/posanbu/Kaguya/issues/247)** — 公共 scene/scope、冻结观察与独立进度。先审查承接开放 [PR #255](https://github.com/posanbu/Kaguya/pull/255)，补齐默认链、defer/替代、恢复与领域 DTO，避免两套状态拥有者。
- **W2 → [#248](https://github.com/posanbu/Kaguya/issues/248)** — 保留完整经历验收；按 #291 后的评论校正正文，删除旧 cognition/Expression 独立进度和保留旧 writer 的假设，保留第 33 条之后更正测试。#265 底座已完成，不重开。
- **W3 → [#249](https://github.com/posanbu/Kaguya/issues/249)** — 行动有效性，补入当前逐段表达、专用 recall、恢复时效性与通用执行器映射，保留取消竞争及 unknown 核对。
- **W9/W10/W11 → [#250](https://github.com/posanbu/Kaguya/issues/250)** — 分别交付 DTO、现有工作台、贯穿验收，用分目标 PR 承接；完整验收依赖 #247/#248/#249 及 W4–W8。
- **W9/W10 → [#178](https://github.com/posanbu/Kaguya/issues/178)** — 保留模块职责与 trace 总追踪，切片改为统一 Memory、Lifecycle、行动/工具/环境和 #250；删除 #192 作为待建独立页面的入口。
- **[#192](https://github.com/posanbu/Kaguya/issues/192)** — 保持按方案替代关闭，表达进入统一 Memory，不恢复独立模块或资料库。
- **W9/W10 → [#193](https://github.com/posanbu/Kaguya/issues/193)** — 复用原编号，按下文改为 Lifecycle 页面，保留历史 Kind 来源。
- **DSH [#286](https://github.com/posanbu/Kaguya/issues/286)/[#287](https://github.com/posanbu/Kaguya/issues/287)/[#288](https://github.com/posanbu/Kaguya/issues/288)** — 保留成果与状态，本轮暂缓同步发布；插件结果不替代 Kaguya 验收。

## W4：Heavy 原生工具循环

**实施 issue** — [#299](https://github.com/posanbu/Kaguya/issues/299)。

**标题** — 实现 Heavy 原生工具循环与持久化调用结果。

**正文草稿** — 父追踪 #279，Owner Astra，依赖 W3/#249，Memory 工具接 W2/#248。当前专用 recall 和原生历史尚未提供通用工具执行链。本项复用行动执行器，接通原生声明、参数校验、call/result、call ID、usage 与多步继续推理；提供受 scope/来源/修订约束的 Memory 查询、阅读、更正和经历回看。工具声明区分权限、版本、并行/串行、取消、幂等及结果核对；长任务独立于单次模型请求。

**验收** — 覆盖多步/并行/有序、失败/不支持/预算、取消/迟到、重启和模型切换，原生历史裁剪保留完整配对。真实模型协议按获配额请求单独验收。迁移明确旧 recall 承接，停新领取后排空，保留调用/结果/unknown，不重复执行；满足台账公共门槛。

## W5：MCP 客户端

**实施 issue** — [#300](https://github.com/posanbu/Kaguya/issues/300)。

**标题** — 接入 MCP stdio 与 Streamable HTTP，统一 tools、resources 和 prompts。

**正文草稿** — 父追踪 #279，Owner Sol，依赖 W3/W4。固定 SDK/规范版本与许可证，管理 stdio 子进程及 Streamable HTTP 的初始化、发现/分页、认证引用、连接/重连、取消及卸载。tools 复用统一执行器；resources 首版按需 list/templates/read，prompts 发现/获取按服务能力接入，保留来源、时间、scope、媒体类型及预算。不支持能力明确报告，模板不越权，凭据不进入模型或普通日志。resource subscriptions、elicitation、MCP tasks 和自动 OAuth 授权暂缓；对外 MCP 服务端另议。

**验收** — 两种 transport 的合成服务实跑 tools/resources/prompts，覆盖鉴权失败、退出、断连、晚到及能力不支持。副作用计数证明重连/重启不盲重发，unknown 进入核对。连接显式启用，停用只清理本组件进程/连接，保留历史与用户资源；满足台账公共门槛。

## W6：隔离环境与租约

**实施 issue** — [#301](https://github.com/posanbu/Kaguya/issues/301)。

**标题** — 建立 rootless Podman 执行环境、资源租约与用户接管。

**正文草稿** — 父追踪 #279，Owner Astra，依赖 W3。目标 Linux 执行前复核 rootless 前置，系统安装整合为用户亲自执行的一份已审查幂等脚本。环境服务拥有执行账户、workspace/environment ID、scene/任务归属、固定镜像、显式挂载/网络/凭据、资源限额、持久目录及产物。租约覆盖完整观察—操作—核对，使用 fencing；浏览器/profile、桌面和账号独占分别声明。默认不授予宿主用户目录、真实桌面或 NapCat。

**验收** — Linux 实测身份/隔离/持久恢复、两 worker 竞争、过期旧持有者、失联及用户接管。接管停止自动输入，恢复前重新观察；取消保留产物。回退停止新任务与租约并排空，保留审计，不删除既有容器/卷/数据库；满足台账公共门槛。

## W7：shell 与 Chromium

**实施 issue** — [#302](https://github.com/posanbu/Kaguya/issues/302)。

**标题** — 在隔离环境接入 shell 与 Chromium DOM/CDP 工具。

**正文草稿** — 父追踪 #279，Owner Sol，依赖 W5/W6（W4 经 W5 传递）。shell 明确 cwd、环境变量、身份、输出、超时/取消、退出码及长任务。Chromium 明确 profile/工作区，提供 DOM/CDP 导航、定位、输入/点击、截图与下载；保持完整租约，核验页面/环境身份，超预算保留产物引用。断连、退出、部分完成及 unknown 分别记录，重连先核对。

**验收** — 真实 Linux shell 核对文件内容及进程状态，真实 Chromium 在合成站点验证导航、动态 DOM、表单、下载；覆盖超时、取消、并发、旧租约和接管。浏览器拦截与后端出口隔离分别留证。显式启用，停用保留长任务/产物，只清理归属明确的临时资源；满足台账公共门槛。

## W8：隔离 GUI 与视觉

**实施 issue** — [#303](https://github.com/posanbu/Kaguya/issues/303)。

**标题** — 接入隔离 GUI 与视觉模型，验证截图、输入及用户接管。

**正文草稿** — 父追踪 #279，Owner Astra，依赖 W5/W6，仅共用浏览器场景依赖 W7。在 rootless 隔离桌面准备合成应用，记录显示身份、分辨率、输入坐标；截图绑定时间、尺寸、环境与租约。获具体配额后探测授权模型的真实图像输入，再接通截图→模型→输入→核对。截图过期、环境变化或接管使旧操作失效；取消不撤销已发生点击/键盘输入，失联后重新观察。

**验收** — 实际隔离 GUI 完成合成任务，以前后截图和应用状态核对；真实视觉请求保存模型/协议/usage，与文本替身分别报告。覆盖旧截图、窗口变化、并发、接管、取消和恢复。停用先停止输入并保留媒体/产物，不控制宿主桌面/NapCat；视觉受阻交主协调决定，满足台账公共门槛。

## W12：Linux 部署

**实施 issue** — [#304](https://github.com/posanbu/Kaguya/issues/304)。

**标题** — 部署持续 Agent 能力底座到 Linux，完成迁移、恢复与回退验收。

**正文草稿** — 父追踪 #279，Owner Sol、Astra 审查，依赖 W11 及用户执行管理员脚本。执行前重新核对生产 SHA/服务；备份并验证 PostgreSQL、Profile/Cordis、epoch、修订和队列恢复点。审查增量迁移及旧调度兼容，停新领取、排空在途工作，按获验收 main SHA 构建启动；核对 Runtime/PostgreSQL、Memory、模型、工具/MCP、环境、页面与重启恢复。NapCat 由用户手动启动，OneBot 状态与消息投递分别验收；真实对外测试消息须有具体授权。

**验收** — 实际 Linux SHA 与获验收提交一致；数据/权限/冻结保持，旧正文不补发，unknown 先核对。隔离环境演练备份恢复或兼容回退，保留新增事实/产物；恢复数据库另核对恢复点后的副作用。交付管理员脚本、实际命令、分项结果和剩余事项；满足台账公共门槛。

## #193 更新草稿

**拟改标题** — Lifecycle 模块领域检视：活动、睡眠、观察与持久调度。

**拟替换正文** — PR #296 已统一为 `agent.lifecycle`/`lifecycle.default`。本项是 #178 的 W9/W10 切片，依赖 #247 的冻结/进度与 W9 DTO，并与 #249/#250 关联。展示当前活动、睡眠/复查、唤醒、观察、预约/触发/替代/失败/恢复；区分当前投影、模型冻结快照和历史事件。旧 `agent.heartbeat.*` 与 `agent.attention.arousal.*` 保留来源，不恢复独立模块。

**验收** — 各视图有根记录、关联来源、查询截止点/完整性，可追溯 scope、时间、水位、尝试和原因；历史预约不报为当前有效。认证/脱敏/只读边界不变，来源缺失/滞后/截断明确显示。验证加载/空态/错误/长字段、桌面/窄屏、Server 查询和真实浏览器交互；文案使用 Lifecycle 语义。本项不更改算法，不增加 SQL/重放/写入口；DTO/Manifest 变化在实现 PR 说明，满足新契约后再调整就绪状态。
