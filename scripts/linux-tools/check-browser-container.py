#!/usr/bin/env python3
"""功能概述：在 CI 按 W6 生产参数创建可信 browser 容器，执行 Chromium 自身 sandbox 门禁。
代码库关系：复用 Broker/PodmanBackend；命令固定为合成 browser-probe，不接收用户 argv。
输入输出与副作用：随机环境、临时 broker 根目录，finally 回收容器/volume，保留原始 Chromium 错误。
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'linux-environments'))
from broker import Broker, PodmanBackend, digest

parser = argparse.ArgumentParser()
parser.add_argument('--archive', required=True)
parser.add_argument('--digest', required=True)
args = parser.parse_args()
backend = PodmanBackend()
backend.env = {k: v for k, v in os.environ.items() if k in ('HOME', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS')}
backend.env.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')
def command(*parts, timeout=30):
    result = subprocess.run(['/usr/bin/podman', *parts], env=backend.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        print(result.stderr.decode(errors='replace'), file=sys.stderr)
        raise RuntimeError('podman-command-failed')
    return result.stdout
backend.command = command
info = json.loads(command('info', '--format=json'))
assert info['host']['security']['rootless'] is True
command('load', '--input', str(Path(args.archive).resolve()), timeout=300)
image = 'localhost/kaguya-chromium@' + args.digest
assert json.loads(command('image', 'inspect', image))[0]['Digest'] == args.digest
key = 'browser-ci-' + uuid.uuid4().hex
with tempfile.TemporaryDirectory() as root:
    broker = Broker(root, backend)
    try:
        env = broker.create({'environmentId': key, 'scope': 'ci', 'workspaceId': key,
                             'resourceIds': [key], 'image': image, 'network': 'none'})
        internal = broker.environments[key]
        result = command('exec', internal['container'], '/usr/local/bin/node', '/opt/kaguya-tools/browser-probe.mjs', timeout=60)
        print(json.dumps({'imageDigest': args.digest, 'runtime': info['version'], 'browser': json.loads(result)}), flush=True)
    finally:
        primary = sys.exc_info()[0] is not None
        failures = []
        try:
            broker.close()
        except Exception as error:
            failures.append(error)
        for env in broker.environments.values():
            try:
                command('rm', '--force', '--ignore', env['container'])
            except Exception as error:
                failures.append(error)
            for prefix, identity in (('kaguya-workspace-', env['workspaceId']), ('kaguya-private-', env['environmentId'])):
                try:
                    command('volume', 'rm', '--force', prefix + digest(identity)[:24])
                except Exception as error:
                    failures.append(error)
            try:
                backend.shell.system('/usr/bin/systemctl', '--user', 'stop', backend.shell.slice(env))
            except Exception as error:
                failures.append(error)
        if failures and not primary:
            raise ExceptionGroup('browser fixture cleanup failed', failures)
