# MCP 客户端

Server 将启用的 MCP 工具注册到现有 Heavy 工具循环和 W3 行动执行器。每个模型步骤仍只生成一次；MCP 客户端负责协议、连接、发现及内容来源，不运行另一套模型循环。

## 配置与启用

`<configRoot>/mcp.json` 缺省不存在，等价于关闭。配置文件与其他宿主配置一样仅由当前用户读写。修改文件后重启 Server；已有配置应用导致 Runtime 重建时也会重读文件。不会联网安装 MCP 服务端。

```json
{
  "version": 1,
  "connections": [
    {
      "id": "example",
      "revision": "r1",
      "enabled": true,
      "protocol": "2025-11-25",
      "transport": {
        "type": "http",
        "url": "https://mcp.example.org/mcp",
        "headerRefs": { "Authorization": "EXAMPLE_MCP_AUTHORIZATION" }
      },
      "scopes": ["[\"qq\",\"napcat.qq.main\",\"group\",\"123456\"]"],
      "tools": [{ "name": "search", "readonly": true, "independent": true }],
      "resourceUriPrefixes": ["example://public/"],
      "prompts": ["summarize"],
      "timeoutMs": 30000,
      "maxPages": 16,
      "maxItems": 256,
      "maxBytes": 1048576
    }
  ]
}
```

环境变量 `EXAMPLE_MCP_AUTHORIZATION` 包含完整 header 值，如 `Bearer …`。配置仅保存引用名。stdio 的 transport 使用 `{ "type": "stdio", "command": "/absolute/server", "args": ["mcp"], "envRefs": { "SERVICE_TOKEN": "MY_SERVICE_TOKEN" } }`，可设置明确的 `cwd`。命令以 `shell=false` 启动，仅继承 PATH、Windows 系统/临时目录及显式配置的环境变量。URL 不接受用户信息、query 或 fragment；HTTP 明文仅允许回环地址，重定向不跟随。

`scopes` 是 W4 的明确平台范围：JSON 数组依次为 platform、adapterId、destination.kind、目标 ID。Web 最后一项是 UUID conversationId。没有通配符。模型只能给出工具参数，不能改变 endpoint、headers、command、环境变量、scope 或白名单。远端 annotations 不授予只读或并行权限。

任何认证身份、权限、凭据或本地策略变化，即使引用环境变量的名称不变，也必须递增连接 `revision` 并受控重建 Runtime。同一连接对象会拒绝凭据值发生变化后的重连；跨进程的身份修订由可信管理员维护。秘密不写入定义、普通日志或 Information 回执。

## 协议与冻结目录

生产依赖锁定 `@modelcontextprotocol/client@2.3.1`、`ajv@8.20.0`，Node 要求为仓库规定的 24.18.0。SDK 包为 Apache-2.0，所附 LICENSE 同时保留早期 MIT 贡献条款。固定来源：[版本清单](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/package.json)、[许可证](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/LICENSE)。

每条连接只能显式选择 `2025-06-18`、`2025-11-25` 或 `2026-07-28`。两个 2025 profile 使用 legacy initialize；现代 profile 固定该版本的 discover。版本不匹配拒绝，不自动降级。stdio 的 discover 与会话共用一个进程，没有探测兄弟进程。

tools/list 使用单页协议 request。整个发现过程受总 deadline、页数、条目数和字节数限制，完成验证后原子发布。JSON Schema 原文保留，支持 draft-07 和默认的 2020-12；不能解析的 schema 使发现失败。输入校验不补默认值、不转换类型、不删除字段，也不请求外部 schema。

定义摘要绑定连接修订、协议、远端原名、输入/输出 schema 和本地策略。W4 冻结声明、wire mapping 及执行 binding。重连不会改写旧 run；执行前再次核对摘要。已经到达的目录变化通知只使目录失效，不启动后台刷新或监听流。显式 reconnect 发布新快照，新的 Runtime 可采用它，旧定义继续保留自己的版本。

现代 HTTP 固定传入 toolDefinition，关闭 SDK 在 HEADER_MISMATCH 后刷新并重发的路径。多轮输入自动处理、OAuth、sampling、elicitation、roots、tasks、subscriptions 和自动 SSE 恢复均未启用。现代 HTTP 不使用旧版 session/GET 恢复；新连接不会继承旧 session 身份。

## 行动结果与资源

W3 在发送前持久登记 intent/attempt。返回的 JSON-RPC ID 与模型 toolCallId、operationId、attemptId 分开保存。断连、输出验证失败、取消或超时保留 unknown；isError 保留 partial 与实际返回，均不自动重发。MCP 没有通用的已执行操作查询接口；unknown 由 W3/管理端核对。取消通知或中断 HTTP 流仅表示停止等待，不能证明远端副作用已停止。

内容信封保留连接与定义修订、scope、获取时间、原始内容/URI/媒体类型，标记 `untrusted-mcp-data`。它不会成为 system 指令或权限。resources 仅按需 list/templates/read，模板展开后的 URI 仍受前缀策略约束。prompts/get 消耗一次性的用户选择，不能通过工具参数制造该选择。

模块可使用 `mcp:resources`、`mcp:prompts` capability；后者只有 list/get，不提供 select。可信管理端通过 `POST /api/mcp/read` 访问，要求 Gateway management Bearer token，正文包含 connectionId、scope 和 kind。kind 为 resources、templates、prompts、resource 或 prompt；resource 另给 uri；prompt 另给 name/arguments，该 POST 本身是明确用户选择。没有执行任意工具、修改连接或隐式读取资源的 HTTP 路由。

## 生命周期、验证与回退

关闭时先停止 Runtime 新推进，再中断 MCP 请求并回收本组件启动的 stdio 进程树。POSIX 使用独立进程组，发信号前核对当前组成员继承的随机 ownership 标记；身份变化或无法读取时保留记录并报告未确认。Windows 在根进程仍存活时用系统 taskkill /T 回收普通派生树。Windows 根进程提前退出时无法从该 PID 确认完整派生树，返回 cleanup failure，并保留所有权记录。主动逃离受管进程组的服务须由 W6 隔离边界管理。

Server 在 `<configRoot>/mcp-processes` 保存 PID、进程组、宿主 PID、平台和启动时间，不保存命令参数或凭据。只有确认回收后才删除记录；宿主异常退出后的记录用于定位与核对，不能把历史 PID 无条件当作当前可杀进程。清理失败保留 owner，后续 shutdown 继续尝试；不另建全机进程追踪器。

`packages/mcp/src/host.test.ts` 用独立 Node 进程验证三个协议和真实 stdio/HTTP（JSON、SSE）、分页、鉴权、目录变化、取消晚到与退出。`apps/server/src/mcp-host.test.ts` 验证完整 Server→Heavy→W3→MCP→回复，使用 PGlite 或显式 PostgreSQL schema。它们进入 critical 门禁，Server 文件同时进入 PostgreSQL 清单。历史 `.worktrees` 保留在磁盘，排除出当前测试收集。

CuaDriver 0.38.0 的真实兼容验证与合成 2025-06-18 协议测试分别记账。当前 Linux 无特权网络命名空间不可用；真实 Cua discovery 留待 W8/W11 在隔离环境执行，不连接用户真实桌面。

回退先关闭连接配置并停止新 run，排空 Runtime 后回收 MCP。保留 W3 intent/attempt/receipt、W4 call/result、来源信封、unknown 和未确认回收的所有权文件。没有数据库迁移、历史回填或删除旧事实的操作。

### 晚到响应证据

取消或超时后的 `unknown` 回执保持不变。只有 transport 实际收到、能匹配原已发送 `tools/call` 的响应，才写入独立的 `mcp.client.late-result.v1` Information。HTTP 已中断且未收到的正文不能作为客户端观察结果。每个 transport 使用独立 generation；JSON-RPC ID 按原类型匹配，未知 ID 与重连后的同号请求不会关联到旧请求。

证据携带 `scopeKey`、原 intent/operation/attempt/model call ID、冻结的连接/定义 revision、接收时间和脱敏响应摘要。Server 复核原 W3 intent/attempt 后 append，允许证据先于 unknown 提交；不调用改变 W3 head 的完成或核对接口。保存失败保留同一事件 ID，关闭等待保存并在失败时保留宿主和数据库供显式重试；已提交的同一事实只读确认，不重复 append 或重发工具。凭据按派发时上下文脱敏，响应仍受 `maxBytes` 限制。回退时保留已写入的 Information Kind 与事实。

## 合成服务的控制与等待

`@kaguya/mcp/testing` 的合成服务通过独立、随机令牌保护的回环控制 socket 应用完整状态，宿主用 `applySyntheticControl` 等待配对 ACK。`state.json` 只用于新进程启动，不监听文件事件；已运行服务不会在写入中间状态时读取它。控制端点只写测试 journal，不进入 MCP 目录、注册项或生产配置。服务按原 method/RPC ID 记录 `held`、`released` 和 `control-applied`。控制 ACK 明确表示状态已应用与哪些 barrier 已释放，不能代替 MCP 请求自身的完成。

结构性 hold 用例采用 fixture-only 16 秒连接/请求预算，8 秒观察与 2 秒控制 ACK 留出 6 秒响应余量；500 ms 实际 HTTP deadline 专测保持原预算。`fixtureBudget` 保守累加 body 上限：ready 8 秒 + 每个 open/reconnect 的握手、分页发现各一份 timeout + 每个 RPC 一份 timeout + 每次观察8秒 + 每次控制ACK2秒 + 每次显式close5秒 + 文件I/O5秒。并行于RPC的观察仍单列，不依赖阶段间借用余量。afterEach清理另有20秒上限。

| 控制用例                        | connections | calls | polls | controls | closes | body上限 |
| ------------------------------- | ----------: | ----: | ----: | -------: | -----: | -------: |
| 延迟 reconnect 旧 provider 拒绝 |           2 |     0 |     1 |        2 |      0 |     89秒 |
| cancel 与迟到，含重连           |           2 |     1 |     3 |        1 |      0 |    119秒 |
| 两代 late RPC                   |           2 |     2 |     4 |        3 |      1 |    152秒 |
| late 保存失败后 close 重试      |           1 |     1 |     2 |        1 |      2 |     89秒 |
| 半写状态且无 watch 通知         |           1 |     1 |     1 |        2 |      0 |     73秒 |
| release 已应用但 ACK 丢失       |           2 |     0 |     1 |        3 |      0 |     91秒 |

500ms专测的两次恢复观察和控制ACK另行计入32.5秒body，未改变实际请求deadline。普通3秒配置下，schema重连、通知、凭据和错误后重连也按同一账本计算。Server晚到fixture沿用其原有分阶段预算，并使用相同ACK控制。清理单独释放控制并等待原工作；主断言、控制 ACK 或原工作任一失败都保留诊断，不跳过后续清理。关闭后的清理仅在确认受控进程已退出时允许端点缺席。

确定性回归在服务 hold 后留下半份 JSON，不发送文件通知，再用控制 ACK 释放真实 stdio/HTTP RPC；另模拟状态已应用但 ACK 丢失，验证原 discovery 仍收敛且主错误与 ACK 错误均保留。完整 MCP 文件及消费该服务的 Server/Linux 组合文件共同验收，不以重复跑绿作为修复证据。
