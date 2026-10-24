/**
 * 功能概述：真实 Cua 输入被中断后的 Driver 组退出及 X11 held/映射收尾验收。
 * 主要职责：冻结 baseline，等待监视器就绪后仅发送一次输入；触发实际状态后 kill，再 release/readback。
 * 代码库关系：gui-interrupt-probe.py 提供确定中断边界，gui-x11.py 是固定可信收尾入口。
 * 输入输出与副作用：只向隔离合成终端输入未执行字符，不按 Enter；不结束应用，不调用模型。
 */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { CuaStdio } from "./cua-stdio.mjs";
const exec = promisify(execFile);
import { x11State as keyboard } from "./gui-x11.mjs";

for (const mode of ["held", "unicode"]) {
  const driver = new CuaStdio();
  let monitor;
  let monitorClosed;
  let primary;
  try {
    await driver.start();
    const windows = await driver.call("list_windows", {});
    const target = windows.structuredContent?.windows.find((w) =>
      JSON.stringify(w).includes("Kaguya isolated terminal"),
    );
    assert.ok(target, "terminal-must-remain-alive");
    const pid = target.pid,
      windowId = target.window_id ?? target.id;
    assert.ok(Number.isSafeInteger(pid) && Number.isSafeInteger(windowId));
    // 先通过一次明确的窗口点击确认输入焦点；以下被中断动作仍单独发送一次。
    const state = await driver.call("get_window_state", {
      pid,
      window_id: windowId,
      max_image_dimension: 0,
    });
    const capture = state.structuredContent?.capture_id;
    assert.ok(capture, "terminal-capture-required");
    const clicked = await driver.call(
      "click",
      {
        pid,
        window_id: windowId,
        x: 30,
        y: 30,
        capture_id: capture,
        delivery_mode: "foreground",
      },
      () => {},
    );
    assert.notEqual(clicked.isError, true);
    const before = await keyboard({ mode: "snapshot" });
    assert.deepEqual(before.keys, []);
    assert.deepEqual(before.buttons, []);
    monitor = spawn(
      "/usr/bin/python3",
      [
        "/opt/kaguya-tools/gui-interrupt-probe.py",
        String(driver.identity().pid),
        mode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    // close 在 spawn error 后也会发生；立即登记，不能在 finally 等可能永不发生的 exit。
    let spawnError;
    monitorClosed = new Promise((resolve) => {
      monitor.once("error", (error) => {
        spawnError = error;
      });
      monitor.once("close", (code) => resolve({ code, error: spawnError }));
    });
    let output = "",
      error = "",
      readyResolve;
    const ready = new Promise((resolve) => {
      readyResolve = resolve;
    });
    monitor.stdout.on("data", (data) => {
      output += data;
      if (output.startsWith("ready\n")) readyResolve();
    });
    monitor.stderr.on("data", (data) => {
      error += data;
    });
    const completed = monitorClosed.then((result) => {
      if (result.error || result.code !== 0)
        throw result.error ?? new Error(error || "monitor-failed");
    });
    await Promise.race([
      ready,
      completed.then(() => {
        throw new Error("monitor-exited-before-ready");
      }),
    ]);
    const request =
      mode === "held"
        ? driver.call(
            "press_key",
            { pid, window_id: windowId, key: "a", delivery_mode: "foreground" },
            () => {},
          )
        : driver.call(
            "type_text",
            {
              pid,
              window_id: windowId,
              text: "中".repeat(1000),
              delivery_mode: "foreground",
            },
            () => {},
          );
    const settled = request.then(
      () => "returned",
      () => "interrupted",
    );
    await completed;
    await driver.stop();
    assert.equal(await settled, "interrupted");
    const interruption = JSON.parse(output.split("\n")[1]);
    const residual = await keyboard({ mode: "snapshot" });
    await writeFile(
      `/home/tool/gui-drain-${mode}.json`,
      JSON.stringify({ mode, before, residual, interruption }),
    );
    if (mode === "held")
      assert.ok(
        residual.keys.length > 0,
        "held-input-must-survive-driver-exit",
      );
    else
      assert.ok(
        residual.mapping.some((row) => row.includes(0x1004e2d)),
        "temporary-mapping-must-survive-driver-exit",
      );
    const reset = await keyboard({
      mode: "reset",
      before,
      expectedKeysyms: mode === "unicode" ? [0x1004e2d] : [],
    });
    assert.deepEqual(reset.keys, []);
    assert.deepEqual(reset.buttons, []);
    if (mode === "unicode") assert.ok(reset.restoredKeycodes.length > 0);
    const after = await keyboard({ mode: "snapshot" });
    assert.deepEqual(after.mapping, before.mapping);
    await exec("/usr/bin/test", ["-d", `/proc/${pid}`]);
    console.log(
      JSON.stringify({
        mode,
        applicationPid: pid,
        interruptedKeys: interruption.observed.keys,
        reset,
        mappingRestored: true,
      }),
    );
  } catch (error) {
    primary = error;
  } finally {
    const errors = primary ? [primary] : [];
    try {
      if (monitor && monitor.exitCode === null && monitor.signalCode === null)
        monitor.kill("SIGKILL");
      await monitorClosed;
    } catch (error) {
      errors.push(error);
    }
    try {
      await driver.stop();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "gui-drain-probe-failed");
  }
}
