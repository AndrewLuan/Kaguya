/**
 * 功能概述：回收受管 stdio 树前核对当前组身份，为 Windows 系统辅助程序限制总等待。
 * verifyOwnedGroup 只查询指定 PGID，核对正常继承的随机 ownership 标记，不追踪全机进程。
 * signalOwnedGroup 仅在当前身份验证成功后发信号；无法确认时保留记录。
 * runTreeHelper 以 shell=false 启动固定命令，deadline 到达时回收辅助进程并报告未确认清理。
 * stdio.ts 调用本文件；命令/环境输出只在内存判断，不进入异常、日志、模型或事实。
 * 历史记录不自动执行；身份无法核对时拒绝向数字 PGID 发信号，保留诊断。
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { McpError } from "./config.js";
const exec = promisify(execFile);
export async function signalOwnedGroup(
  groupId: number,
  ownerTag: string,
  signal: NodeJS.Signals,
  deadline: number,
  verify: typeof verifyOwnedGroup = verifyOwnedGroup,
) {
  if (!(await verify(groupId, ownerTag, deadline)))
    throw new McpError("mcp-stdio-group-identity-unconfirmed");
  process.kill(-groupId, signal);
}
export async function verifyOwnedGroup(
  groupId: number,
  ownerTag: string,
  deadline: number,
): Promise<boolean> {
  try {
    const options = {
      timeout: Math.max(1, Math.min(1000, deadline - Date.now())),
      maxBuffer: 1048576,
    };
    const found = await exec(
      "/usr/bin/pgrep",
      ["-g", String(groupId)],
      options,
    );
    const pids = found.stdout.trim().split(/\s+/);
    if (!pids.length || pids.some((pid) => !/^\d+$/.test(pid))) return false;
    const details = await exec(
      "/bin/ps",
      ["eww", "-p", pids.join(","), "-o", "pid=,command="],
      options,
    );
    const lines = details.stdout.trim().split("\n");
    return (
      lines.length === pids.length &&
      lines.every((line) => line.includes(`KAGUYA_MCP_OWNER=${ownerTag}`))
    );
  } catch {
    return false;
  }
}
export async function runTreeHelper(
  command: string,
  args: string[],
  deadline: number,
  onStarted?: (pid: number) => void,
): Promise<void> {
  const child = spawn(command, args, {
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reapTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        if (child.pid) onStarted?.(child.pid);
      });
      child.once("error", () => reject(new McpError("mcp-tree-helper-failed")));
      child.once("exit", (code) =>
        timedOut || code !== 0
          ? reject(new McpError("mcp-tree-helper-unconfirmed"))
          : resolve(),
      );
      timer = setTimeout(
        () => {
          timedOut = true;
          child.kill("SIGKILL");
          reapTimer = setTimeout(
            () => reject(new McpError("mcp-tree-helper-unconfirmed")),
            200,
          );
        },
        Math.max(1, deadline - Date.now() - 250),
      );
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(reapTimer);
    if (child.pid && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}
