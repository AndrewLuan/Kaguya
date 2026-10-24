/** 功能概述：在 bubblewrap 最终 namespace 内、真正启动命令前核对固定 permit 截止时间。
 * 代码库关系：service.mjs 传入已绑定操作的截止值和 argv；环境/文件视图由外层 sandbox 固定。
 * 输入输出与副作用：仅启动一次指定命令，继承隔离后的 stdio；许可过期退出且不运行用户命令。 */
import { spawn } from 'node:child_process';
const [expiry, command, ...args] = process.argv.slice(2);
if (!Number.isFinite(Number(expiry)) || Number(expiry) <= Date.now()) process.exit(125);
const child = spawn(command, args, { stdio: 'inherit' });
child.once('error', () => { process.exitCode = 126; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 126); });
