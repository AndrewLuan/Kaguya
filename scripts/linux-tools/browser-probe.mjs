/**
 * 功能概述：真实 rootless Chromium 前置门禁，直接读取浏览器自身 sandbox 页面并验证动态 DOM。
 * 代码库关系：仅 CI 由固定镜像运行；使用与生产相同的 chromiumSandbox:true 和私有 profile。
 * 输入输出与副作用：仅合成页面与 /private 临时 profile；失败输出 Chromium 原始诊断，不降级参数。
 */
import { chromium } from '/opt/kaguya-browser/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';
const context = await chromium.launchPersistentContext('/private/sandbox-probe', { channel: 'chromium', headless: true, chromiumSandbox: true, timeout: 15000 });
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('chrome://sandbox');
  const sandbox = await page.locator('body').innerText();
  await writeFile('/private/sandbox-probe.txt', sandbox);
  console.error(JSON.stringify({ chromium: context.browser().version(), sandbox }));
  for (const check of [/Layer 1 Sandbox\s+Namespace/i, /PID namespaces\s+Yes/i, /Network namespaces\s+Yes/i, /Seccomp-BPF sandbox\s+Yes/i, /Seccomp-BPF sandbox supports TSYNC\s+Yes/i, /You are adequately sandboxed\./i]) {
    if (!check.test(sandbox)) throw new Error('chromium-sandbox-not-proven:' + sandbox);
  }
  await page.goto('about:blank');
  await page.setContent('<button id="go">submit</button><output id="value"></output><script>go.onclick=()=>value.textContent="verified"</script>');
  await page.getByRole('button', { name: 'submit' }).click();
  if (await page.locator('#value').innerText() !== 'verified') throw new Error('dynamic-dom-not-verified');
  console.log(JSON.stringify({ playwright: '1.64.1', chromium: context.browser().version(), sandbox, uid: process.getuid(), dynamicDom: true }));
} finally { await context.close(); }
