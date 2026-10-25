"""功能概述：仅供 drain 验收的 X11 请求屏障，转发真实 Cua 数据，不生成输入。
主要职责：read_setup/read_request 保持 X11 帧边界；InputBarrier 在目标请求后封闭所有后续请求。
代码库关系：gui-interrupt-probe.py 注入目标匹配器，在屏障后验证真实 X11 状态并停止驱动。
输入输出与副作用：独立 Unix socket 代理 :99；服务端回复正常转发，关闭时取消连接任务并回收 socket。
"""
import asyncio
import os
from pathlib import Path
import socket
import struct


async def read_setup(reader):
    header = await reader.readexactly(12)
    if header[0] not in (ord("l"), ord("B")):
        raise RuntimeError("invalid-x11-byte-order")
    order = "<" if header[0] == ord("l") else ">"
    if struct.unpack_from(order + "H", header, 2)[0] != 11:
        raise RuntimeError("invalid-x11-protocol-version")
    auth, data = struct.unpack_from(order + "HH", header, 6)
    tail = await reader.readexactly(((auth + 3) // 4 + (data + 3) // 4) * 4)
    return header + tail, order


async def read_request(reader, order):
    header = await reader.readexactly(4)
    length = struct.unpack_from(order + "H", header, 2)[0] * 4
    if length == 0:
        header += await reader.readexactly(4)
        length = struct.unpack_from(order + "I", header, 4)[0] * 4
    if not len(header) <= length <= 16 * 1024 * 1024:
        raise RuntimeError("invalid-x11-request-length")
    return header + await reader.readexactly(length - len(header))


def matches_request(packet, order, opcode, mode, keycodes):
    # BIG-REQUESTS 在标准四字节头后插入额外长度字段。
    offset = 4 if packet[2:4] != b"\0\0" else 8
    if mode == "unicode":
        if packet[0] != 100:
            return False
        if len(packet) < offset + 4 or len(packet) != offset + 4 + packet[1] * packet[offset + 1] * 4:
            raise RuntimeError("invalid-x11-keyboard-mapping-request")
        return 0x1004e2d in struct.unpack(order + "I" * ((len(packet) - offset - 4) // 4),
                                         packet[offset + 4:])
    if packet[0] != opcode or packet[1] != 2:
        return False
    if len(packet) != offset + 32:
        raise RuntimeError("invalid-xtest-fake-input-request")
    kind, detail = packet[offset:offset + 2]
    return (kind == 4 and detail == 1) if mode == "button" else (kind == 2 and detail in keycodes)


class InputBarrier:
    def __init__(self, path, target="/tmp/.X11-unix/X99"):
        self.path, self.target = Path(path), target
        self.match = None
        self.hit = asyncio.Event()
        self.lock = asyncio.Lock()
        self.tasks = set()
        self.writers = set()
        self.server = None
        self.accept_task = None
        self.failure = asyncio.get_running_loop().create_future()
        self.forwarded_target = None
        self.identified = asyncio.Event()
        self.check_peer = None

    def authorize(self, check_peer):
        self.check_peer = check_peer
        self.identified.set()

    async def start(self):
        # 拒绝覆盖已有 endpoint；每个 mode 由调用方使用独立 display。
        if self.path.exists():
            raise RuntimeError("fixture-display-already-exists")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            listener.bind(str(self.path))
            self.server = listener
            os.chmod(self.path, 0o600)
            listener.listen()
            listener.setblocking(False)
            self.accept_task = asyncio.create_task(self.accept())
        except BaseException:
            listener.close()
            raise

    async def accept(self):
        try:
            while True:
                connection, _ = await asyncio.get_running_loop().sock_accept(self.server)
                try:
                    reader, writer = await asyncio.open_unix_connection(sock=connection)
                except BaseException:
                    connection.close()
                    raise
                self.connected(reader, writer)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not self.failure.done():
                self.failure.set_result(error)

    def connected(self, reader, writer):
        task = asyncio.create_task(self.connection(reader, writer))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def connection(self, client, downstream):
        self.writers.add(downstream)
        upstream = None
        children = []
        try:
            await self.identified.wait()
            self.check_peer(downstream.get_extra_info("socket"))
            server, upstream = await asyncio.open_unix_connection(self.target)
            self.writers.add(upstream)

            async def replies():
                while data := await server.read(65536):
                    downstream.write(data)
                    await downstream.drain()

            async def requests():
                setup, order = await read_setup(client)
                upstream.write(setup)
                await upstream.drain()
                while True:
                    packet = await read_request(client, order)
                    async with self.lock:
                        if self.hit.is_set():
                            # 只由 close 取消；不以定时器放行，不发送 release/恢复映射。
                            await asyncio.Future()
                        target = self.match is not None and self.match(packet, order)
                        upstream.write(packet)
                        await upstream.drain()
                        if target:
                            self.forwarded_target = packet
                            self.hit.set()

            children = [asyncio.create_task(requests()), asyncio.create_task(replies())]
            done, _ = await asyncio.wait(children, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        except Exception as error:
            if not self.failure.done():
                self.failure.set_result(error)
        finally:
            for task in children:
                task.cancel()
            await asyncio.gather(*children, return_exceptions=True)
            for writer in (downstream, upstream):
                if writer is not None:
                    writer.transport.abort()
                    self.writers.discard(writer)

    async def close(self):
        if self.server is not None:
            self.server.close()
        if self.accept_task is not None:
            self.accept_task.cancel()
            await asyncio.gather(self.accept_task, return_exceptions=True)
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        for writer in self.writers:
            writer.transport.abort()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.server is not None:
            self.path.unlink(missing_ok=True)
