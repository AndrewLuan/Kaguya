/**
 * 功能概述：首阶段真实 Cua discovery/跨 UID 观察探针，保存固定二进制的协议证据。
 * 主要职责：启动同一生产 stdio 适配器，读取窗口和原始桌面截图；不连接任何模型。
 * 代码库关系：check-gui-container.py 启动 GTK fixture 后调用；后续动作验收共用此通道。
 * 输入输出与副作用：证据写入可信 HOME，stdout 只含摘要；finally 等待 Driver 进程组消失。
 */
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { CuaStdio } from "./cua-stdio.mjs";
await mkdir("/home/tool/runtime", { mode: 0o700, recursive: true });
const driver = new CuaStdio();
const evidence = {};
const text = (result) =>
  result.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
const element = (result, name) => {
  const rows = text(result);
  const snapshot = /snapshot_id=([^\s]+)/.exec(rows)?.[1];
  const row = rows.split("\n").find((line) => line.includes('"' + name + '"'));
  const index = /\[(\d+)\]/.exec(row ?? "")?.[1];
  assert.ok(snapshot && index, "fixture-element-token-missing");
  return `${snapshot}:${index}`;
};
try {
  const wish = spawnSync("wish", [], { env: { PATH: "/opt/cua/helpers" } });
  assert.equal(
    wish.error?.code,
    "ENOENT",
    "trusted-driver-must-not-resolve-wish",
  );
  evidence.wishExcluded = true;
  const discovery = (evidence.discovery = await driver.start());
  const windows = (evidence.windows = await driver.call("list_windows", {}));
  assert.notEqual(windows.isError, true);
  assert.match(JSON.stringify(windows), /Kaguya GUI acceptance/);
  const pid = Number(process.argv[2]);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const window = (evidence.window = await driver.call("get_window_state", {
    pid,
    max_image_dimension: 0,
  }));
  assert.notEqual(window.isError, true);
  assert.match(text(window), /Unsaved text/);
  assert.match(text(window), /Increment once/);
  const desktop = (evidence.desktop = await driver.call("get_desktop_state", {
    max_image_dimension: 0,
  }));
  assert.notEqual(desktop.isError, true);
  for (const result of [window, desktop]) {
    const image = result.content?.find((c) => c.type === "image");
    assert.equal(image?.mimeType, "image/png");
    const bytes = Buffer.from(image.data, "base64");
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 1280);
    assert.ok(bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 800);
  }
  const windowId = Number(/window_id=(\d+)/.exec(text(window))?.[1]);
  assert.ok(windowId > 0);
  const buttonState = await driver.call("get_window_state", {
    pid,
    window_id: windowId,
  });
  const click = (evidence.click = await driver.call(
    "click",
    {
      pid,
      window_id: windowId,
      element_token: element(buttonState, "Increment once"),
    },
    () => assert.equal(process.getuid(), 1000),
  ));
  assert.notEqual(click.isError, true);
  const entryState = await driver.call("get_window_state", {
    pid,
    window_id: windowId,
  });
  const typed = (evidence.typed = await driver.call(
    "type_text",
    {
      pid,
      window_id: windowId,
      element_token: element(entryState, "Unsaved text"),
      text: "W8 暂存",
      delivery_mode: "foreground",
    },
    () => assert.equal(process.getuid(), 1000),
  ));
  assert.notEqual(typed.isError, true);
  evidence.after = await driver.call("get_window_state", {
    pid,
    window_id: windowId,
  });
  assert.match(text(evidence.after), /W8 暂存/);
  console.log(
    JSON.stringify({
      driver: driver.identity(),
      tools: discovery.discovered.tools.length,
      windows,
      desktop: {
        ...desktop,
        content: desktop.content?.map((c) =>
          c.type === "image"
            ? {
                type: c.type,
                mimeType: c.mimeType,
                bytes: Buffer.from(c.data, "base64").length,
              }
            : c,
        ),
      },
    }),
  );
} catch (error) {
  console.error(driver.diagnostics);
  throw error;
} finally {
  try {
    await writeFile(
      "/home/tool/gui-probe.json",
      JSON.stringify(evidence, null, 2),
    );
  } finally {
    await driver.stop();
  }
}
