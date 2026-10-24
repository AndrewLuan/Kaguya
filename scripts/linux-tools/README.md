# Linux shell 工具

W7 的 init 管理持久 job；helper 为 W6 协议 1 的单请求客户端。每次实际启动前检查固定 permit；查询只读取状态，不延长旧 job 许可。到期、stop、关闭或接管停止受管进程组。start 的 `accepted` 与命令 `exited` 分开，退出码、signal、时间和 stdout/stderr hash 保留在 workspace 回执中。重放相同 operation 查询既有 job；重启后的在途记录标为 unknown，不重新运行。

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

镜像使用固定 Node 24.18.0 amd64 基础 digest，在构建阶段复制代码，没有运行时下载。CI `Linux tools image` 构建 OCI archive，分别记录 archive SHA-256 与 image manifest digest，上传构建产物，并使用 W6 的生产容器参数执行 rootless ready、写文件、退出及代次恢复验证。CI 临时 runner 与生产 Ubuntu 的 bootstrap、账户、防火墙和存储安装分别验收。部署复用 W6 `image.import`；无需再次管理员安装。

本地合成检查使用 `node --test scripts/linux-tools/check-shell.mjs`，操作真实子进程及临时文件。当前 shell 镜像不提供 browser/GUI 工具；对应 health 不声明这些能力。Chromium 和实际 sandbox 另行交付。
