/**
 * 功能概述：跨平台验证 Linux 原生注册的 scope/target、串行 lease 绑定及关闭资源归属。
 * 使用受控 transport 核对实际 RPC；不将其视为 Podman 或 shell 运行证明。
 * 代码库关系：消费生产 LinuxToolsHost/Client，受影响 schema 与 hooks 均在此覆盖。
 */
import { describe, expect, it } from "vitest";
import { LinuxToolsHost, linuxShellSchema } from "./linux-tools.js";
import { LinuxEnvironmentClient } from "./environment.js";

describe("Linux native shell registry", () => {
  it("serializes acquire/renew and keeps tokens out of bindings and registrations", async () => {
    const calls: string[] = [];
    const environment = {
      environmentId: "env",
      generation: 0,
      workspaceId: "work",
      resourceIds: ["shell"],
      workflowId: "flow",
      leaseId: "lease",
      fencing: "1",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    const client = new LinuxEnvironmentClient(async (method) => {
      calls.push(method);
      if (method === "lease.acquire")
        return { environment, token: "private-token-not-for-the-model-123456" };
      if (method === "lease.renew") return environment;
      return {};
    });
    const host = new LinuxToolsHost(
      {
        version: 1,
        revision: "one",
        bindings: [
          { scope: "scope", environmentId: "env", workflowId: "flow" },
        ],
      },
      client,
    );
    try {
      const refs = await Promise.all([host.bind("scope"), host.bind("scope")]);
      expect(calls).toEqual(["lease.acquire", "lease.renew"]);
      expect(JSON.stringify(refs)).not.toContain("private-token");
      const tool = host.snapshot().nativeTools.registrations[0]!;
      const binding = await tool.bind({
        scope: "scope",
        arguments: {},
        runInformationId: "run",
        stepInformationId: "step",
      });
      const intent = {
        environment: binding.environment,
        scope: "scope",
        target: binding.target,
        providerId: "linux.environment",
        executor: "linux",
      } as any;
      expect(await tool.authorize({ intent, mode: "execute" })).toBe(true);
      expect(
        await tool.authorize({
          intent: { ...intent, scope: "other" },
          mode: "execute",
        }),
      ).toBe(false);
      await expect(host.bind("other")).rejects.toThrow("scope-denied");
      expect(
        linuxShellSchema.safeParse({
          mode: "start",
          argv: ["/bin/true"],
          token: "injected",
        }).success,
      ).toBe(false);
      expect(
        linuxShellSchema.safeParse({
          mode: "verify",
          original: { operationId: "op", attemptId: "attempt" },
          path: "a",
        }).success,
      ).toBe(true);
    } finally {
      await host.close();
    }
    expect(calls.at(-1)).toBe("lease.release");
    await expect(host.bind("scope")).rejects.toThrow();
  });
});
