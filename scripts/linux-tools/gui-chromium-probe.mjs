/**
 * 功能概述：真实 Cua 对应用 UID Chromium 的 AX、PNG、点击及文本输入验收。
 * 主要职责：只读轮询实际 AX 就绪，动作各发一次；保存原图与完整 Cua 回执供宿主核对页面 ledger。
 * 代码库关系：应用启动与事件记录在 gui-chromium-fixture.mjs；与 GTK 共用 CuaStdio 边界。
 * 输入输出与副作用：仅合成页面，截图不缩放；未知结果不补发，finally 停止 Driver。
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CuaStdio } from "./cua-stdio.mjs";
const driver = new CuaStdio();
const evidence = {};
const pid = Number(process.argv[2]);
assert.ok(Number.isSafeInteger(pid) && pid > 1);
const text = (r) =>
  r.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
async function state(
  contains,
  matches = (result) => text(result).includes(contains),
) {
  const deadline = Date.now() + 15000;
  while (true) {
    const result = await driver.call("get_window_state", {
      pid,
      max_image_dimension: 0,
    });
    assert.notEqual(result.isError, true);
    if (matches(result)) return result;
    if (Date.now() >= deadline)
      throw new Error(`chromium-AX-timeout:${text(result).slice(0, 2000)}`);
    await delay(20);
  }
}
function element(result, name) {
  const rows = text(result);
  const snapshot = /snapshot_id=([^\s]+)/.exec(rows)?.[1];
  const row = rows
    .split("\n")
    .find((line) => /\[\d+\]/.test(line) && line.includes(`"${name}"`));
  const index = /\[(\d+)\]/.exec(row ?? "")?.[1];
  assert.ok(snapshot && index, "chromium-element-missing");
  return `${snapshot}:${index}`;
}
try {
  await driver.start();
  evidence.before = await state("Browser increment once");
  const windowId = Number(/window_id=(\d+)/.exec(text(evidence.before))?.[1]);
  assert.ok(windowId > 0);
  evidence.click = await driver.call(
    "click",
    {
      pid,
      window_id: windowId,
      element_token: element(evidence.before, "Browser increment once"),
    },
    () => {},
  );
  assert.notEqual(evidence.click.isError, true);
  const entry = (evidence.entry = await state("Count: 1"));
  evidence.type = await driver.call(
    "type_text",
    {
      pid,
      window_id: windowId,
      element_token: element(entry, "Browser unsaved text"),
      text: "W8 browser ASCII",
      delivery_mode: "foreground",
    },
    () => {},
  );
  assert.notEqual(evidence.type.isError, true);
  evidence.after = await state("W8 browser ASCII");
  // 单独打开 sandbox 页，确认 Chromium 自身报告，再关闭该页保留原页未保存输入。
  const browserInput = async (name, args) => {
    const result = await driver.call(
      name,
      { pid, window_id: windowId, delivery_mode: "foreground", ...args },
      () => {},
    );
    assert.notEqual(result.isError, true, JSON.stringify(result));
  };
  await browserInput("hotkey", { keys: ["ctrl", "t"] });
  await state("New Tab", (result) =>
    (result.structuredContent?.window_title ?? "").includes("New Tab"),
  );
  await browserInput("type_text", { text: "chrome://sandbox" });
  await browserInput("press_key", { key: "enter" });
  evidence.sandbox = await state("You are adequately sandboxed.");
  for (const label of [
    "Namespace",
    "PID namespaces",
    "Network namespaces",
    "Seccomp-BPF sandbox",
    "TSYNC",
  ])
    assert.ok(text(evidence.sandbox).includes(label), label);
  await browserInput("hotkey", { keys: ["ctrl", "w"] });
  evidence.restored = await state("W8 browser ASCII");
  const image = evidence.after.content?.find((item) => item.type === "image");
  assert.equal(image?.mimeType, "image/png");
  const bytes = Buffer.from(image.data, "base64");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 1280);
  assert.ok(bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 800);
  await writeFile("/home/tool/gui-chromium.png", bytes);
  console.log(
    JSON.stringify({
      pid,
      windowId,
      text: text(evidence.after),
      screenshot: "gui-chromium.png",
      sandboxText: text(evidence.sandbox),
    }),
  );
} finally {
  try {
    await writeFile(
      "/home/tool/gui-chromium-probe.json",
      JSON.stringify(evidence),
    );
  } finally {
    await driver.stop();
  }
}
