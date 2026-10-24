/**
 * 功能概述：验证人工 GUI 会话从宿主控制到 broker RPC 的身份、秘密和去重合同。
 * 主要职责：显式 barrier 控制接管与输入返回，验证续租不会越过接管、丢失回执不重复输入。
 * 代码库关系：使用真实 LinuxToolsHost/Client 和受控 transport；物理排空由 Linux helper 测试承担。
 * 输入输出与副作用：全内存；finally 释放 barrier 并关闭宿主，不调用模型或真实桌面。
 */
import { describe, expect, it } from "vitest";
import { LinuxEnvironmentClient, type BrokerTransport } from "./environment.js";
import { LinuxToolsHost } from "./linux-tools.js";

const success = {
  status: "succeeded",
  evidence: "returned",
  result: {},
  artifacts: [],
  truncated: false,
};
function fixture() {
  const calls: { method: string; params: Record<string, any> }[] = [];
  const state = {
    generation: 0,
    state: "ready",
    sessionId: "",
    failHandoff: false,
    failInput: false,
    handoffGate: undefined as Promise<void> | undefined,
    inputGate: undefined as Promise<void> | undefined,
  };
  const entered = Promise.withResolvers<void>();
  const inputEntered = Promise.withResolvers<void>();
  const snapshot = () => ({
    environmentId: "env",
    scope: "scope",
    generation: state.generation,
    state: state.state,
    ...(state.sessionId
      ? {
          human: {
            sessionId: state.sessionId,
            expiresAt: "2099-01-01T00:00:00Z",
          },
        }
      : {}),
    token: "should-be-projected-away",
  });
  const transport: BrokerTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === "lease.acquire" || method === "lease.renew")
      return method === "lease.acquire"
        ? {
            token: "lease-secret-with-at-least-32-characters",
            environment: {
              environmentId: "env",
              generation: state.generation,
              workspaceId: "workspace",
              resourceIds: ["desktop"],
              workflowId: "flow",
              leaseId: "lease",
              fencing: "1",
              expiresAt: "2099-01-01T00:00:00Z",
            },
          }
        : params.environment;
    if (method === "environment.handoff") {
      entered.resolve();
      await state.handoffGate;
      state.generation = Number(params.generation) + 1;
      state.state = "human";
      state.sessionId = (params.humanSession as { id: string }).id;
      if (state.failHandoff) {
        state.failHandoff = false;
        throw new Error("lost-ack");
      }
      return snapshot();
    }
    if (method === "human.execute") {
      inputEntered.resolve();
      await state.inputGate;
      if (state.failInput) throw new Error("lost-input-receipt");
      return success;
    }
    if (method === "human.query") {
      const original = calls.find(
        (call) => call.method === "human.execute",
      )!.params;
      return {
        operationId: original.operationId,
        attemptId: original.attemptId,
        outcome: success,
      };
    }
    if (method === "human.close" || method === "environment.resume") {
      state.generation = Number(params.generation) + 1;
      state.state = method === "human.close" ? "human" : "ready";
      state.sessionId = "";
    }
    return snapshot();
  };
  const client = new LinuxEnvironmentClient(transport);
  const host = new LinuxToolsHost(
    {
      version: 1,
      revision: "one",
      bindings: [
        { environmentId: "env", scope: "scope", workflowId: "flow", gui: true },
      ],
    },
    client,
  );
  return { client, host, calls, state, entered, inputEntered };
}

describe("manual GUI host", () => {
  it("reuses private credentials after lost handoff ACK and projects public state", async () => {
    const f = fixture();
    f.state.failHandoff = true;
    try {
      await expect(f.host.handoff("env", 0, "control")).rejects.toThrow(
        "lost-ack",
      );
      const publicState = await f.host.handoff("env", 0, "control");
      expect(f.calls[0]!.params).toEqual(f.calls[1]!.params);
      expect(JSON.stringify(publicState)).not.toContain("token");
      const privateToken = f.calls[0]!.params.humanSession.token;
      expect(JSON.stringify(publicState)).not.toContain(privateToken);
      expect(publicState.human?.sessionId).toHaveLength(64);
      await expect(f.host.bind("scope")).rejects.toThrow();
      await f.host.maintain();
      expect(
        f.calls.filter((call) => call.method.startsWith("lease.")),
      ).toHaveLength(0);
    } finally {
      await f.host.close();
    }
  });

  it("fences queued lease renewal at handoff and resumes only after confirmed control", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    f.state.handoffGate = gate.promise;
    let handoff: Promise<unknown> | undefined;
    try {
      await f.host.bind("scope");
      handoff = f.host.handoff("env", 0, "control");
      await f.entered.promise;
      await f.host.maintain();
      await expect(f.host.bind("scope")).rejects.toThrow();
      expect(
        f.calls.filter((call) => call.method === "lease.renew"),
      ).toHaveLength(0);
      gate.resolve();
      await handoff;
      await f.host.resume("env", 1, "resume");
      expect((await f.host.bind("scope")).generation).toBe(2);
    } finally {
      gate.resolve();
      await handoff;
      await f.host.close();
    }
  });

  it("keeps unknown input identity and queries facts without another dispatch", async () => {
    const f = fixture();
    f.state.failInput = true;
    try {
      const current = await f.host.handoff("env", 0, "control");
      const request = {
        environmentId: "env",
        generation: current.generation,
        sessionId: current.human!.sessionId,
        operationId: "op",
        toolName: "gui.observe" as const,
        arguments: { target: { kind: "desktop" } },
      };
      const first = await f.host.operateHuman(request);
      expect(first.outcome.status).toBe("unknown");
      expect(await f.host.operateHuman(request)).toEqual(first);
      const query = await f.host.queryHuman("env", "op");
      expect(query.attemptId).toBe(first.attemptId);
      expect(query.outcome.status).toBe("succeeded");
      expect(first.outcome.status).toBe("unknown");
      expect(
        f.calls.filter((call) => call.method === "human.execute"),
      ).toHaveLength(1);
      expect(() =>
        f.host.operateHuman({
          ...request,
          arguments: { target: { kind: "window", pid: 1, windowId: 2 } },
        }),
      ).toThrow("human-operation-conflict");
    } finally {
      await f.host.close();
    }
  });

  it("allows close to drain an in-flight human operation without waiting behind it", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    f.state.inputGate = gate.promise;
    let action: Promise<unknown> | undefined;
    try {
      const current = await f.host.handoff("env", 0, "control");
      const session = {
        environmentId: "env",
        generation: 1,
        sessionId: current.human!.sessionId,
      };
      action = f.host.operateHuman({
        ...session,
        operationId: "op",
        toolName: "gui.observe",
        arguments: { target: { kind: "desktop" } },
      });
      await f.inputEntered.promise;
      expect((await f.host.closeHuman(session)).state).toBe("human");
      expect(() =>
        f.host.operateHuman({
          ...session,
          operationId: "late",
          toolName: "gui.observe",
          arguments: { target: { kind: "desktop" } },
        }),
      ).toThrow("human-session-unavailable");
      expect(
        f.calls.filter((call) => call.method === "human.execute"),
      ).toHaveLength(1);
    } finally {
      gate.resolve();
      await action;
      await f.host.close();
    }
  });
});
