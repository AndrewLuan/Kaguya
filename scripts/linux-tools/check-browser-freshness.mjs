/**
 * 功能概述：用受控 DOM 准备屏障验证观察到期与下载控制 epoch，不冒充真实 Chromium。
 * 代码库关系：消费生产 BrowserComponent，覆盖异步 page/state 返回后的最终授权检查。
 * 输入输出与副作用：模拟时钟与内存观察；finally 释放全部屏障，不启动浏览器或网络。
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { BrowserComponent } from "./browser.mjs";
import { createHash } from "node:crypto";

const fixture = () => {
  let now = 0;
  const clock = mock.method(Date, "now", () => now);
  const component = new BrowserComponent();
  component.service = {
    mode: "automation",
    generation: 0,
    environmentId: "env",
    closed: false,
  };
  const page = {
    targetId: "target",
    loaderId: "doc",
    sessionId: "session",
    frameId: "frame",
    executionContextId: 1,
  };
  const state = {
    url: "https://example.com",
    viewport: {},
    html: "<button>submit</button>",
    inputs: [],
    nodes: [
      {
        id: "n0",
        selector: "button",
        text: "done",
        visible: true,
        inViewport: true,
      },
    ],
  };
  const observation = {
    id: "a".repeat(64),
    environmentId: "env",
    workflowId: "flow",
    generation: 0,
  };
  const expected = {
    url: state.url,
    viewport: state.viewport,
    html: state.html,
    inputs: state.inputs,
  };
  component.observations.set(observation.id, {
    ref: observation,
    scope: "scope",
    leaseId: "lease",
    fencing: "1",
    expires: 1000,
    page,
    expected,
    nodes: state.nodes,
    contentHash: createHash("sha256")
      .update(JSON.stringify(expected))
      .digest("hex"),
  });
  let sends = 0;
  component.connection = {
    send: () => {
      sends++;
      return { result: { value: { dispatched: true } } };
    },
    drain: async () => true,
  };
  const environment = {
    environmentId: "env",
    generation: 0,
    leaseId: "lease",
    workflowId: "flow",
    fencing: "1",
  };
  const request = (toolName, args) => ({
    helperProtocolVersion: 1,
    kind: "operation",
    toolName,
    arguments: { observation, ...args },
    scope: "scope",
    operationId: "op",
    attemptId: "attempt",
    digest: "digest",
    environment,
    permit: {
      ...environment,
      expiresAt: new Date(5000).toISOString(),
      operationId: "op",
      attemptId: "attempt",
      digest: "digest",
    },
  });
  return {
    component,
    page,
    state,
    request,
    setTime: (value) => {
      now = value;
    },
    sends: () => sends,
    close: () => clock.mock.restore(),
  };
};

test(
  "observation expiry during page preparation prevents the final input write",
  { timeout: 5000 },
  async () => {
    const f = fixture(),
      entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    f.component.page = async () => {
      entered.resolve();
      await release.promise;
      return f.page;
    };
    const work = f.component.execute(
      f.request("browser.act", { action: "click", nodeId: "n0" }),
    );
    const checked = assert.rejects(work, /input-fenced/);
    try {
      await entered.promise;
      f.setTime(1000);
      release.resolve();
      await checked;
      assert.equal(f.sends(), 0);
      assert.equal(await f.component.isolate(), true);
    } finally {
      release.resolve();
      await checked;
      f.close();
    }
  },
);

test(
  "verification cannot return verified after its observation expires during DOM reading",
  { timeout: 5000 },
  async () => {
    const f = fixture(),
      entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    f.component.page = async () => f.page;
    f.component.state = async () => {
      entered.resolve();
      await release.promise;
      return f.state;
    };
    const work = f.component.execute(
      f.request("browser.verify", {
        mode: "page",
        original: { operationId: "old", attemptId: "old-attempt" },
        expectation: { kind: "text", nodeId: "n0", equals: "done" },
      }),
    );
    const checked = assert.rejects(work, /input-fenced/);
    try {
      await entered.promise;
      f.setTime(1000);
      release.resolve();
      await checked;
    } finally {
      release.resolve();
      await checked;
      f.close();
    }
  },
);

test("handoff closes the old download attribution window", async () => {
  const f = fixture();
  try {
    f.component.lastInput = {
      scope: "scope",
      frameId: "frame",
      generation: 0,
      controlEpoch: 0,
      deadline: 5000,
      operationId: "old",
      attemptId: "old-attempt",
    };
    f.component.service.mode = "draining";
    await f.component.isolate();
    f.component.service.mode = "human";
    const id = "12345678-1234-4234-8234-123456789abc";
    f.component.event({
      method: "Browser.downloadWillBegin",
      params: {
        guid: id,
        frameId: "frame",
        url: "https://example.com/manual.csv",
        suggestedFilename: "manual.csv",
      },
    });
    const file = f.component.downloads.get(id);
    assert.equal(file.correlation, "unattributed");
    assert.equal(file.operationId, undefined);
    assert.equal(file.attemptId, undefined);
    assert.equal(file.generation, undefined);
  } finally {
    f.close();
  }
});
