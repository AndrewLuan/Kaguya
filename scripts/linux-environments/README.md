# Linux 隔离工具环境

这里提供 W6 的管理员安装入口和独立环境 broker。管理员脚本由用户在 **Linux 本机终端**执行。聊天代理不代跑 sudo。适用目标是 Ubuntu 26.04 x86_64、systemd 和 cgroup v2；安装会核对实际 UID、subuid/subgid、存储与 rootless Podman。

## 安装前审查

一起审查 `bootstrap.py`、`server.py`、`broker.py`、`packages.lock.json`，记录四个文件的 SHA-256。将这四个文件保存在同一个目录。`bootstrap.py check --trusted-user andrew` 只读预检，不需要 root；`apply` 会修改下述 W6 专属系统资源。安装不会拉镜像、创建容器任务，也不会修改或重启 Kaguya、PostgreSQL、QQ/NapCat。

```bash
sha256sum bootstrap.py server.py broker.py packages.lock.json
python3 -I bootstrap.py check --trusted-user andrew
sudo /usr/bin/python3 -I bootstrap.py apply --trusted-user andrew
```

安装进程使用独立的 USTC Ubuntu 源和 Ubuntu archive keyring 校验的索引，不改系统源。`packages.lock.json` 精确锁定 Podman、uidmap、passt、crun、fuse-overlayfs；系统依赖使用兼容范围，保留已安装版本并拒绝执行栈降级。安装前后均确认 dpkg 状态为 `install ok installed`，回执记录实际版本及源文件 hash。脚本安装 `podman uidmap passt crun fuse-overlayfs python3 dbus-user-session libpam-systemd ca-certificates acl nftables e2fsprogs util-linux`。不增加外部包仓库，不全局关闭 AppArmor，不使用 rootful 回退。安装阶段以 `kaguya-tools` 实际执行 `podman info`、`podman unshare`；失败停止安装并保留诊断，后续修复对应权限或配置。

**账户与持久数据** — 创建锁定、无登录 shell 的 `kaguya-tools`，HOME 为 `/var/lib/kaguya-tools`。从现有 `/etc/subuid`、`/etc/subgid` 的未占用范围分配至少 65536 个 ID，并检查重叠。现存冲突账户或不同 trusted UID 会被拒绝。

**容量** — 首次安装预留两个实际分配的 ext4 镜像文件：容器镜像、工作卷和容器日志共用 24 GiB；broker journal 与产物共用独立 4 GiB。它们挂载在 `/var/lib/kaguya-tools-storage/containers` 和 `state`。产物再受单件 16 MiB、总量 2 GiB 限制。容器写满工作卷会得到 ENOSPC，不能继续占用宿主剩余磁盘。该限制是两个环境共用的总容量，不是每个命名卷独立 quota。格式化使用 `nodiscard`，发布前及挂载后复核实际分配块数、ext4 类型与 loop backing file。已有存储镜像不会重新格式化。安装加独占锁；硬中断留下的 `.preparing` 仅在本安装身份、root 所有权、单链接与未关联 loop 设备均确认后清理重建。首次安装要求这 28 GiB 加 4 GiB 空闲余量。

**代码与连接** — root 拥有 `/usr/local/lib/kaguya-tools/{server,broker}.py`、`/etc/kaguya-tools/config.json` 和 `storage.conf`。broker 以专用 UID 运行，socket 为 `/run/kaguya-tools/broker.sock`。目录 traverse ACL 与 socket ACL 仅授予安装时指定的宿主用户；每条连接另用内核 `SO_PEERCRED` 核对 UID，不接受请求中自报 UID。socket 不能访问 Podman API。

**系统单元** — 安装两个存储 mount unit、`kaguya-tools-network.service`、仅针对专用 UID 的 `user@UID.service.d/kaguya-tools.conf`、`kaguya-tools-broker.service` 和 `/etc/tmpfiles.d/kaguya-tools.conf`。只给专用账户启用 linger。宿主 broker 的任务上限为 1200、内存上限为 10 GiB；每个工具容器为 2 CPU、4 GiB 内存、512 PID、512 MiB 共享内存，最多注册两个环境。

**网络** — 默认环境 `network=none`。显式 `public-web` 使用 pasta，宿主独立 nftables table 限制该专用 UID：只允许公共地址 TCP 80/443 和 DNS，拒绝本机地址、私网、链路本地、tailnet、IPv4 映射 IPv6 等特殊地址。仅对 systemd-resolved 的 `127.0.0.53:53` 提供本机 DNS 例外。它是 IP/端口边界，不是域名白名单；DNS 查询仍可能传出数据。安装只管理 `inet kaguya_tools`，不 flush 其他规则。W7/W8 验收还须实际检查 IPv4/IPv6、宿主地址及重定向路径。

## 非 root 后续部署

使用已经审查并固定 digest 的 W7/W8 完整工具镜像。基础 Playwright 镜像本身尚不提供 Kaguya helper。镜像必须包含 `/opt/kaguya-tools/init` 和 `/opt/kaguya-tools/helper`，并支持 UID/GID 1000、只读 rootfs、`no-new-privileges`、全部 capability 丢弃、独立 IPC/PID/network 和 Chromium sandbox。禁止通过关闭 sandbox 获得启动成功。

HOME tmpfs 使用 Podman 支持的 `mode=0700,U`，按容器用户 1000:1000 设置所有权；不直接传入解析器不支持的 `uid=`/`gid=`。实际挂载所有者、权限与可写性由工具镜像 CI 和生产预检分别核对。

受信宿主用户可将 OCI archive 放入 `/var/lib/kaguya-tools-storage/containers/inbox/<SHA256>.oci`，通过 `image.import` RPC 提交 SHA-256。broker 使用 `O_NOFOLLOW` 打开，复制到不可由宿主用户写入的私有区，校验全文件 SHA-256 后执行固定的 `podman load`。文件大小最多 12 GiB，导入需要预留一份复制空间。随后 `environment.create` 使用完整的 `name@sha256:...`；`--pull=never` 保证执行时不会自行更新镜像。导入和环境管理是宿主管理操作，不注册成模型工具。

所有 RPC 为单连接、单 JSON 行：`{"protocol":1,"method":"health","params":{}}`。请求最多 256 KiB，最多 16 个并发连接。`health` 不启动任务。业务输入错误返回稳定错误码，不输出原始请求或异常堆栈。

## 生命周期与 W3 接口

`environment.create` 固定 scope、workspace、resource 集合、镜像 digest 与 network policy。workspace/resource 不允许被另一环境重复注册。每代容器拥有独立名称，工作卷按 workspace 保留。没有任何可由请求指定的宿主 bind mount；容器只取得命名工作卷，不取得 broker 程序、unit、journal、凭证或宿主仓库。

`lease.acquire` 返回公开 `ActionEnvironment` 与一次性秘密 token。公开引用可以进入 W3 intent；token 只保存在受信宿主内存，通过 `ActionExecution.leaseCredential` 传到实际入口。broker 仅持久化 token hash。lease 必须覆盖完整 observe → act → verify；浏览器和 GUI 共用同一环境 lease。过期不自动转授，需要显式恢复隔离旧执行者。已派发 permit 的截止时间固定为操作 deadline 与当次 lease 到期时间的较早者；后续 renew 不会延长旧 permit。helper 必须在每次实际输入前核验 permit，并在到期时停止旧自动化输入。broker 的 collect 超时会隔离整个容器并保留 unknown。

`operation.execute` 在实际启动入口再次检查 scope、workspace/resources、workflow、lease、generation、fencing、token 和 deadline。固定 `intentId/attemptId/operationId/digest` 与参数的内部 hash；同 operation 换参数、attempt 或 generation 会被拒绝。已派发但无结果的记录返回 unknown，不再次执行。

`operation.cancel` 携带原 operation 和当前 `controlEnvironment`、当前 token、W3 已验证的 `controlAuthorizationId`。未见 operation 也持久保存 tombstone，阻止迟到 dispatch。已执行的取消会隔离当前容器；停止进程不能证明之前没有效果，因此保留 unknown 或已取得的真实成功回执。

`environment.recover` 停止旧容器并确认无运行 PID，再建立新代次，保留 workspace。人工接管使用 `environment.handoff`：先关闭 broker 自动化入口，再等待内部服务确认隔离旧输入通道，然后推进 generation 并进入 human；桌面与未保存内容保持原进程。`environment.resume` 同样经过内部确认推进 generation，随后必须重新 acquire 和 observe。确认失败保持 draining，不开放新 owner。接管与恢复都携带当前 generation 和宿主签发的 controlAuthorizationId。

`operation.reconcile` 以新 lease 读取原 journal，原 attempt/generation 不变，绝不调用 helper，也不等于核对了外部状态。W7/W8 若需要核实文件、job 或站点回执，应以新 lease 发起独立 verify operation，绑定原 operation/attempt，再由 W3 核对证据；不得重跑原动作。

文件 journal 是 broker 的物理执行凭据，不替代 Kaguya Information 账本。每条记录独立原子发布并 fsync，序号不可覆盖。每次修改追加新记录，旧 unknown、取消、代次和回执都保留。关闭时先拒绝领取、隔离环境、阻止迟到写入，再释放独占 journal 锁；重启先隔离旧环境，等待显式接管，不恢复派发。效果发生后、回执写入前崩溃，仍然是 unknown。

## 镜像 helper 协议 1

`/opt/kaguya-tools/init` 是容器固定入口，维护长驻内部服务、进程树及当前 generation；`/opt/kaguya-tools/helper` 是一次 JSON 请求/响应客户端。`podman exec` 不继承 init 运行后设置的变量；DISPLAY、DBus、浏览器与内部 socket 地址必须由镜像固定配置或受控运行文件提供。HOME `/home/tool` 是临时 tmpfs，持久 browser profile、job 回执和产物放 `/workspace`。初始身份由 `KAGUYA_HELPER_PROTOCOL_VERSION`、`KAGUYA_ENVIRONMENT_ID`、`KAGUYA_ENVIRONMENT_GENERATION` 提供。

**就绪** — broker 发送 `{"helperProtocolVersion":1,"kind":"health"}`。helper 等待内部服务真正就绪后返回 `{"helperProtocolVersion":1,"ready":true,"generation":0}`，generation 必须匹配当前环境。固定健康请求预算 15 秒；仅容器 running 不算就绪。

**执行** — stdin 包含 `helperProtocolVersion:1`、`kind:"operation"`、原 operation/attempt/digest、scope、原公开 environment、toolName、target、arguments、deadline 及 `permit`，不含 token。permit 含 environmentId、generation、fencing、leaseId、workflowId、operationId、attemptId、digest、expiresAt。内部服务必须与自己持有的当前身份和到期时间核对，每次实际输入均重新检查；不能只在 helper 进程启动时检查。broker 的字段检查不证明 GUI observation 有效。

W7/W8 负责 opaque observation registry，将 observation ID 绑定内容 hash/尺寸、session/window 或 page epoch、scope/workflow、lease/generation/fencing、有效期。`browser.act` 首版每次只允许一个实际输入，旧 DOM/截图引用在 epoch 或 generation 变化后失效。恢复自动化必须重新观察，不能由调用方换填 generation 复用旧观察。

**人工接管** — 控制请求为 `kind:"control",action:"handoff"`，带 environmentId、expectedGeneration、generation、mode（human 或 automation）及稳定 controlOperationId。内部服务在保持桌面进程的前提下隔离旧自动化输入；完成后返回 `helperProtocolVersion:1,automationIsolated:true,generation,mode`。同一 controlOperationId 重发必须幂等返回同一确认，不能再次推进 generation。实际 GUI 输入隔离由 W8 镜像实现并验收。

**结果与长任务** — stdout 是单个 JSON outcome，保留工具原生回执于 result。helper 返回只证明返回，不自动升级到外部效果已验证。W3 默认 provider 预算约 29 秒，socket 310 秒与 broker collect 上限 300 秒不扩大该预算。长命令由 W7 实现持久 job 的短 RPC：start 返回 accepted 与稳定 jobId，accepted 不等于 exited；查询和 stop 都是新 lease 约束下的新 operation，init 管理进程树及到期隔离。断开 socket 不是取消证明。job 的许可续期与停止规则必须由 W7 明确验证后才开放。

**产物** — stdout 总计最多 24 MiB。helper 必须在 base64 编码前限制附件原始总大小为 16 MiB，单件也不超过 16 MiB，最多 8 件；result 与其余 JSON 预留在 1 MiB 内。支持 PNG/JPEG/WebP、纯文本、CSV、JSON、PDF、ZIP、octet-stream 和 WebM 的明确 MIME，不能把二进制伪标为 text。超出附件预算时保留有效 outcome，将 `truncated` 设为 true；完整文件保留在 workspace，result 的 exports 记录相对路径、原始大小与 SHA-256。后续通过独立受授权 operation 读取/导出，由 W7 实现目录约束、路径与 hash 复核；broker 不直接打开调用方给出的路径。

broker 为每次采集生成独立 UUID ArtifactRef，内容 hash 仅用于 blob 去重；不可变内部记录保留原 scope/action/attempt/operation/environment/generation。单次附件限额或累计 2 GiB 配额不足时，broker 保留返回 outcome 与 result 中的 workspace 引用，并设置 truncated。历史产物按原 scope 读取，失败和接管不自动删除。W7/W8 完整镜像与上述实际输入/导出能力分别交付，本 PR 的受控 helper 测试不冒充实际图形环境验收。

## 自检与验收

```bash
python3 -B -m unittest discover -s scripts/linux-environments -p 'test_broker.py'
```

这组测试使用受控后端，证明协议与日志边界。真实 Linux 验收必须另行证明实际 peer credentials、rootless/cgroup/AppArmor、磁盘容量、网络边界、Chromium sandbox、GUI/D-Bus/AT-SPI、接管后的物理隔离和重启恢复。W7/W8 完整镜像交付后才能验证浏览器与 GUI。尚未执行的项目必须记录为 pending。

## 回退

在 Linux 本机执行：

```bash
sudo /usr/bin/python3 -I bootstrap.py rollback --trusted-user andrew
```

回退不要求安装时的空闲磁盘余量。先停止专用 broker，让它隔离容器；检查仍有运行容器时停止回退并保留网络边界。随后停用专用账户 linger、user manager 和 W6 网络单元。账户、subid、程序、两个存储镜像、mount unit、journal、工作区和产物全部保留，便于核对与恢复。回退不删除历史操作，不触碰 Kaguya 数据库；重新安装/启动后仍先隔离旧环境，再由宿主显式接管。

若需最终卸载，应在确认产物已归档后单独安排；本脚本不删除账户、映射、挂载或存储镜像。
