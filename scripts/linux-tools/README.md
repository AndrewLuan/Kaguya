# Linux shell 工具

宿主 broker 管理持久 shell job，每个 job 在独立 rootless 容器和 systemd user unit 中执行。控制 manifest、permit、回执与 stdout/stderr 均留在宿主私有目录；任意命令只取得 workspace。桌面 init/helper 仅承担可信组件协议，不执行 shell。到期、stop、关闭或接管必须确认 job 整个 cgroup 与容器已停止；start 的 accepted 与命令 exited 分开。重复 operation 读取同一 job，未知结果不重跑。

`shell.exec` 参数的 mode 为 start、query、stop、verify、export。start 接收绝对可执行文件 argv、workspace 相对 cwd 和独立 env。不会继承宿主环境，禁止通过 env 覆盖 helper 身份。verify 在新 operation 下读取真实文件或原 job 回执，明确携带原 operationId/attemptId；journal reconcile 仍只读 W6 journal。export 限定 workspace 普通文件，拒绝路径穿越与符号链接；stdout/stderr 使用 jobId/stream 引用。附件按单件及原始总额 16 MiB 限制，超限保留完整文件、大小和 hash，可按 offset/maxBytes 分段读取。

Server 从敏感配置目录的 `linux-tools.json` 显式启用；文件不存在即关闭。配置样例：

```json
{
  "version": 1,
  "revision": "one",
  "bindings": [
    {
      "scope": "explicit-scope",
      "environmentId": "prepared-environment",
      "workflowId": "explicit-workflow"
    }
  ]
}
```

配置文件权限与 `mcp.json` 相同。环境由宿主管理 API 预先创建，绑定的 scope 不能由模型更改。每次工具 bind acquire/renew 外层 lease；renew 不延长已派发 job 的 permit。当前长 job 到期停止全树，不开放隐式续权。切换配置前排空 Runtime 并关闭工具宿主；恢复隔离环境需要宿主显式 recover。停用不删除 job、profile、文件、产物或 Kaguya 账本。

镜像使用固定 Node 24.18.0 amd64 基础 digest，在构建阶段复制代码，没有运行时下载。CI `Linux tools image` 构建 OCI archive，分别记录 archive SHA-256 与 image manifest digest，上传构建产物，并使用 W6 的生产容器参数执行 rootless ready、写文件、退出及代次恢复验证。CI 临时 runner 与生产 Ubuntu 的 bootstrap、账户、防火墙和存储安装分别验收。镜像导入复用 W6 `image.import`；新增宿主监督模块须纳入最终统一 bootstrap bundle，旧 staging 暂缓执行。

`node --test scripts/linux-tools/check-shell.mjs` 验证可信组件的隔离屏障；Python 专项验证持久身份和真实文件边界。真实容器及独立截止行为由 `check-container.py` 在 Linux runner 验证。当前 shell 镜像不提供 browser/GUI 工具；对应 health 不声明这些能力。Chromium 和实际 sandbox 另行交付。

## Chromium DOM 工具

可信 Chromium 镜像固定 Playwright 1.64.1 所带 Chromium 156.0.8078.4。Playwright 包用于定位浏览器，运行中的 owner 使用私有 `remote-debugging-pipe`；调试地址不开放到 TCP。宿主用 `sandboxPolicy: "chromium-v1"` 创建环境，broker 匹配已审查的 runtime/default-profile hash 并选择对应 seccomp。运行时不下载依赖。Server 对所需 binding 显式添加 `"browser": true` 后，才注册 `browser.observe`、`browser.act`、`browser.verify`。

`observe` 返回当前页面的 DOM 节点、视口、内容 hash 和短期观察引用，可附 JPEG 截图。观察由可信组件保存，绑定 scope、lease、fencing、workflow、generation 和 document；改写返回字段不能改变授权。`act` 只接受一次 navigate、click、fill 或 select；输入后引用即消耗。click 使用 DOM activation，fill/select 使用原生 setter 和合成 input/change 事件。这些 DOM 语义不等同 trusted pointer/键盘；视觉输入由 W8 交付。工具不接受脚本、CDP 方法、宿主路径或任意 profile。

输入函数在独立 world 的同一 renderer 任务里核对完整 HTML、表单属性、视口、URL 和截止时间。准备阶段及每次 pipe 写入另验固定 permit。handoff 先封门、清空旧观察，再等待 connection/session/id 表中的真实 CDP 回执；断连、丢失回执和目标异常保持 unknown/draining，不用 detach 或客户端超时制造成功 ACK。页面、owner PID、未保存输入和 profile 在正常 handoff/resume 中保留；恢复自动化后必须重新观察。已接受输入启动的异步网站业务可能随后完成，使用新 operation 下的 verify 核对，不重复点击。

`verify` 明确引用原 operationId/attemptId；broker 核对原 browser.act 属于同一 scope/environment/workspace。页面核对读取当前 DOM；下载核对要求 `verificationKind: "current-file-state"`，读取私有持久文件的 hash 与范围，不重放输入。下载保留原 URL、报告的 MIME、文件名、时间和原操作关联窗口；回执固定标注 `association=heuristic` 与 `causalAttribution=unconfirmed`，不把文件核对当作原操作造成下载的证明。完整文件在 `/private` 保留，附件仍遵循 16 MiB 总额，可按 offset/maxBytes 分段导出。未知下载不会被当作原操作已完成。

`browser_checks.py` 经生产 broker/helper 驱动单一 owner，使用独立本机站点与 fsync 提交计数验证真实 DOM、下载及页面保留。CI 同镜像默认/候选策略 A/B 读取 Chromium 自身 sandbox 状态，并记录实际 OCI 的非 root、空 capabilities、NNP、只读 rootfs。Ubuntu 24.04 / Podman 4.9.3 的结果与生产 Ubuntu 26.04 / Podman 5.7.0 的现场验收分别记录。
