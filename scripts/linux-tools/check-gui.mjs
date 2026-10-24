/**
 * 功能概述：GUI provider 的许可、一次性观察及双向排空合同测试，不连接模型或真实桌面。
 * 主要职责：用显式 barrier 制造准备/发送/释放交错，核对零旧输入、未知结果不重放和 ACK 时点。
 * 代码库关系：直接调用 gui.mjs；实际 Cua/X11 行为继续由 check-gui-container.py 验证。
 * 输入输出与副作用：仅临时 HOME；测试结束等待收尾并删除，PNG 字节用于原尺寸/hash 配对断言。
 */
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GuiComponent } from "./gui.mjs";

const barrier = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const baseline = { keys: [], buttons: [], mapping: [[0]], per: 1 };
const target = { kind: "window", pid: 123, windowId: 456 };
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "kaguya-gui-"));
  const service = {
    home,
    environmentId: "env",
    generation: 0,
    mode: "automation",
    closed: false,
    instanceId: "service",
  };
  const state = { now: 1000000, input: [], stops: 0, resets: 0, drivers: [] };
  const component = new GuiComponent({
    now: () => state.now,
    keyboard: async (request) => {
      if (request.mode === "snapshot") {
        state.baselineStarted?.resolve();
        await state.baselineWait?.promise;
        return baseline;
      }
      state.resets++;
      state.resetStarted?.resolve();
      await state.resetWait?.promise;
      if (state.failReset) throw new Error("release-unconfirmed");
      state.resetFinished = true;
      return { keys: [], buttons: [], restoredKeycodes: [], roundTrip: true };
    },
    driverFactory: () => {
      const driver = {
        start: async () => ({}),
        identity: () => ({ pid: 10 }),
        stop: async () => {
          state.stops++;
          state.pendingInput?.reject(new Error("driver-stopped"));
        },
        call: async (name, args, gate) => {
          if (name === "get_window_state")
            return {
              content: [
                {
                  type: "text",
                  text: 'window_id=456 pid=123 snapshot_id=s00000001\n- [0] text "Input" value="original"',
                },
                {
                  type: "image",
                  mimeType: "image/png",
                  data: png.toString("base64"),
                },
              ],
              structuredContent: {
                capture_id: "capture-1",
                coordinate_frame: "window",
                screenshot_frame_valid: true,
                screenshot_width: 1,
                screenshot_height: 1,
                window_bounds: { x: 42, y: 43, width: 1, height: 1 },
                pid: 123,
                window_id: 456,
                snapshot_id: "s00000001",
              },
            };
          gate();
          state.input.push({ name, args });
          state.inputStarted?.resolve();
          if (state.pendingInput) return state.pendingInput.promise;
          return {
            structuredContent: {
              effect: state.effect ?? "confirmed",
              route: "accessibility",
            },
            content: [{ type: "text", text: "input receipt" }],
          };
        },
      };
      state.drivers.push(driver);
      return driver;
    },
  });
  await component.ready(service);
  t.after(async () => {
    state.baselineWait?.resolve();
    state.resetWait?.resolve();
    try {
      await component.close();
    } catch (error) {
      if (!state.failReset) throw error;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  let sequence = 0;
  const request = (toolName, args) => {
    const operationId = `operation-${++sequence}`;
    const environment = {
      environmentId: "env",
      generation: service.generation,
      leaseId: "lease",
      workflowId: "workflow",
      fencing: 1,
    };
    return {
      kind: service.mode === "human" ? "human-operation" : "operation",
      toolName,
      arguments: args,
      scope: "scope",
      environment,
      operationId,
      attemptId: "attempt",
      digest: "digest",
      permit: {
        ...environment,
        operationId,
        attemptId: "attempt",
        digest: "digest",
        expiresAt: new Date(state.now + 60000).toISOString(),
        ...(service.mode === "human"
          ? { audience: "human", humanSessionId: service.humanSessionId }
          : {}),
      },
    };
  };
  const observe = async () =>
    (await component.execute(request("gui.observe", { target }))).result
      .observation;
  const click = (observation) =>
    request("gui.act", {
      action: "click",
      observation,
      selector: { kind: "pixel", x: 0, y: 0 },
    });
  return { component, service, state, request, observe, click };
}

test("PNG bytes and window coordinates remain paired; input consumes its observation", async (t) => {
  const f = await fixture(t);
  const observed = await f.component.execute(
    f.request("gui.observe", { target }),
  );
  assert.deepEqual(
    Buffer.from(observed.artifacts[0].dataBase64, "base64"),
    png,
  );
  assert.equal(
    observed.result.image.sha256,
    createHash("sha256").update(png).digest("hex"),
  );
  assert.deepEqual(observed.result.image.origin, { x: 42, y: 43 });
  assert.equal(observed.result.image.coordinateFrame, "window");
  assert.equal(observed.result.image.scale, 1);
  const result = await f.component.execute(
    f.click(observed.result.observation),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(f.state.input.length, 1);
  assert.equal(f.state.input[0].args.capture_id, "capture-1");
  assert.equal(f.state.resets, 1);
  await assert.rejects(
    f.component.execute(f.click(observed.result.observation)),
    /stale-gui-observation/,
  );
  assert.equal(f.state.input.length, 1);
});

test("expired capture, changed lease, wrong generation and unsupported actions send nothing", async (t) => {
  for (const kind of ["expiry", "lease", "generation", "outside", "launch"]) {
    const f = await fixture(t),
      observation = await f.observe(),
      request = f.click(observation);
    if (kind === "expiry") f.state.now += 30001;
    if (kind === "lease") {
      request.permit.leaseId = "replacement";
      request.environment.leaseId = "replacement";
    }
    if (kind === "generation") f.service.generation++;
    if (kind === "outside") request.arguments.selector.x = 1;
    if (kind === "launch")
      request.arguments = {
        observation,
        action: "launch_app",
        command: "ignored",
      };
    await assert.rejects(f.component.execute(request));
    assert.equal(f.state.input.length, 0, kind);
  }
});

test("handoff during baseline preparation fences the final stdin send", async (t) => {
  const f = await fixture(t),
    observation = await f.observe();
  f.state.baselineStarted = barrier();
  f.state.baselineWait = barrier();
  const action = f.component.execute(f.click(observation));
  await f.state.baselineStarted.promise;
  f.service.mode = "draining";
  const handoff = f.component.isolate();
  f.state.baselineWait.resolve();
  assert.equal((await action).status, "unknown");
  assert.equal(await handoff, true);
  assert.equal(f.state.input.length, 0);
});

test("both audiences wait for input release before handoff acknowledgement", async (t) => {
  for (const audience of ["automation", "human"]) {
    const f = await fixture(t);
    f.service.mode = audience;
    f.service.humanSessionId = "human-session";
    const observation = await f.observe();
    f.state.pendingInput = barrier();
    f.state.inputStarted = barrier();
    f.state.resetStarted = barrier();
    f.state.resetWait = barrier();
    const action = f.component.execute(f.click(observation));
    await f.state.inputStarted.promise;
    f.service.mode = "draining";
    let acknowledged = false;
    const handoff = f.component.isolate().then(() => {
      assert.equal(
        f.state.resetFinished,
        true,
        "ACK must follow reset completion",
      );
      acknowledged = true;
    });
    try {
      await f.state.resetStarted.promise;
      await nextTurn();
      assert.equal(acknowledged, false);
    } finally {
      f.state.resetWait.resolve();
    }
    await handoff;
    assert.equal((await action).status, "unknown");
    assert.equal(f.state.input.length, 1);
  }
});

test("unconfirmed release never acknowledges isolation or starts a new driver", async (t) => {
  const f = await fixture(t),
    observation = await f.observe();
  f.state.failReset = true;
  await assert.rejects(
    f.component.execute(f.click(observation)),
    /release-unconfirmed/,
  );
  await assert.rejects(f.component.isolate(), /release-unconfirmed/);
  await assert.rejects(f.observe(), /gui-drain-unconfirmed/);
  assert.equal(f.state.drivers.length, 1);
});

test("unverifiable Cua result stays unknown and is never resent", async (t) => {
  const f = await fixture(t),
    observation = await f.observe();
  f.state.effect = "unverifiable";
  assert.equal(
    (await f.component.execute(f.click(observation))).status,
    "unknown",
  );
  await assert.rejects(
    f.component.execute(f.click(observation)),
    /stale-gui-observation/,
  );
  assert.equal(f.state.input.length, 1);
});
