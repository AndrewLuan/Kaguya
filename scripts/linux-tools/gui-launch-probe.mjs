/**
 * 功能概述：通过真实 Cua 桌面快捷键和 Openbox 菜单启动合成身份标记。
 * 主要职责：每个快捷键及菜单选择只发一次，保存菜单原图；宿主独立读取 marker 回执。
 * 代码库关系：gui-openbox.xml 固定两个入口，gui-launch-marker.py 以派生应用身份落盘。
 * 输入输出与副作用：不运行 Cua launch_app/脚本，不执行终端文本；finally 回收 Driver。
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { CuaStdio } from "./cua-stdio.mjs";
import { x11State } from "./gui-x11.mjs";
const driver = new CuaStdio();
const before = await x11State({ mode: "snapshot" });
try {
  await driver.start();
  const input = async (name, args) => {
    const result = await driver.call(
      name,
      { scope: "desktop", delivery_mode: "foreground", ...args },
      () => {},
    );
    assert.notEqual(result.isError, true, JSON.stringify(result));
  };
  await input("hotkey", { keys: ["alt", "f8"] });
  await input("hotkey", { keys: ["alt", "f9"] });
  const menu = await driver.call("get_desktop_state", {
    max_image_dimension: 0,
  });
  const image = menu.content?.find((item) => item.type === "image");
  assert.equal(image?.mimeType, "image/png");
  await writeFile("/home/tool/gui-menu.png", Buffer.from(image.data, "base64"));
  await writeFile("/home/tool/gui-menu-observation.json", JSON.stringify(menu));
  await input("press_key", { key: "down" });
  await input("press_key", { key: "enter" });
} finally {
  await driver.stop();
  await x11State({ mode: "reset", before, expectedKeysyms: [] });
}
