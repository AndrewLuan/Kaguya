"""功能概述：真实 Unix socket 验证 CI X11 屏障的分帧、身份准入与关闭行为。
主要职责：BarrierTest 发送分片握手、合并 down/release 和跨连接请求；验证目标只转发一次，后继永不放行。
代码库关系：调用 gui_input_barrier 的实际代理；主 Linux GUI fixture 另验证固定 Cua 与真实 X server。
输入输出与副作用：仅临时 socket 与内存 X11 数据；无需桌面、Podman 或固定 sleep，所有事件等待有界。
"""
import asyncio
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from gui_input_barrier import InputBarrier, matches_request, read_request, read_setup


def setup(order):
    header = bytearray(12)
    header[0] = ord("l") if order == "<" else ord("B")
    struct.pack_into(order + "HHHH", header, 2, 11, 0, 3, 5)
    return bytes(header) + b"MIT\0token\0\0\0"


def event(order, kind, detail, opcode=132):
    return bytes([opcode, 2]) + struct.pack(order + "H", 9) + bytes([kind, detail]) + bytes(30)


class BarrierTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="x11-")
        self.addCleanup(self.directory.cleanup)
        self.records, self.tasks, self.clients = [], [], []
        self.received = asyncio.Queue()
        self.backend = await asyncio.start_unix_server(self.accept, path=self.directory.name + "/real")
        self.barrier = InputBarrier(self.directory.name + "/proxy", self.directory.name + "/real")
        await self.barrier.start()
        self.barrier.authorize(lambda _: None)
        self.addAsyncCleanup(self.close)

    def accept(self, reader, writer):
        async def serve():
            record = []
            self.records.append(record)
            try:
                initial, order = await read_setup(reader)
                record.append(initial)
                writer.write(b"setup-ack")
                await writer.drain()
                while True:
                    packet = await read_request(reader, order)
                    record.append(packet)
                    self.received.put_nowait(packet)
                    writer.write(b"request-ack")
                    await writer.drain()
            except (asyncio.IncompleteReadError, ConnectionError):
                pass
            finally:
                writer.close()
                await writer.wait_closed()
        self.tasks.append(asyncio.create_task(serve()))

    async def close(self):
        await asyncio.wait_for(self.barrier.close(), 2)
        for writer in self.clients:
            writer.close()
            await writer.wait_closed()
        self.backend.close()
        await self.backend.wait_closed()
        await asyncio.wait_for(asyncio.gather(*self.tasks), 2)

    async def client(self, order):
        reader, writer = await asyncio.open_unix_connection(str(self.barrier.path))
        self.clients.append(writer)
        # 每次发送一个字节，服务端必须等完整 auth 名称/数据及 padding 后才能转发请求。
        for byte in setup(order):
            writer.write(bytes([byte]))
            await writer.drain()
        self.assertEqual(await asyncio.wait_for(reader.readexactly(9), 2), b"setup-ack")
        return reader, writer

    async def test_little_endian_coalesced_release_and_other_connections_are_blocked(self):
        await self.coalesced("<")

    async def test_big_endian_coalesced_release_and_other_connections_are_blocked(self):
        await self.coalesced(">")

    async def coalesced(self, order):
        reader, writer = await self.client(order)
        _, other = await self.client(order)
        down, release = event(order, 2, 38), event(order, 3, 38)
        self.barrier.match = lambda packet, byte_order: matches_request(packet, byte_order, 132, "held", {38})
        writer.write(down + release)
        await writer.drain()
        await asyncio.wait_for(self.barrier.hit.wait(), 2)
        self.assertEqual(await asyncio.wait_for(self.received.get(), 2), down)
        self.assertEqual(await asyncio.wait_for(reader.readexactly(11), 2), b"request-ack")
        other.write(release)
        await other.drain()
        await self.close()
        self.assertEqual([p for record in self.records for p in record[1:]], [down])
        self.assertTrue(self.received.empty())
        self.assertEqual(self.barrier.tasks, set())
        self.assertFalse(self.barrier.path.exists())

    async def test_unarmed_packets_and_server_replies_pass_unchanged(self):
        reader, writer = await self.client("<")
        packets = [event("<", 2, 38), event("<", 3, 38)]
        writer.write(b"".join(packets))
        await writer.drain()
        for packet in packets:
            self.assertEqual(await asyncio.wait_for(self.received.get(), 2), packet)
        self.assertEqual(await asyncio.wait_for(reader.readexactly(22), 2), b"request-ack" * 2)
        self.assertFalse(self.barrier.hit.is_set())

    async def test_peer_denial_and_invalid_frames_fail_closed(self):
        self.barrier.authorize(lambda _: (_ for _ in ()).throw(RuntimeError("peer-denied")))
        _, writer = await asyncio.open_unix_connection(str(self.barrier.path))
        self.clients.append(writer)
        writer.write(setup("<"))
        await writer.drain()
        error = await asyncio.wait_for(self.barrier.failure, 2)
        self.assertEqual(str(error), "peer-denied")
        self.assertEqual(self.records, [])

    async def test_fragmented_big_request_and_invalid_length(self):
        packet = bytes([132, 2, 0, 0]) + struct.pack("<I", 10) + bytes([2, 38]) + bytes(30)
        reader = asyncio.StreamReader()
        for byte in packet:
            reader.feed_data(bytes([byte]))
        self.assertEqual(await read_request(reader, "<"), packet)
        self.assertTrue(matches_request(packet, "<", 132, "held", {38}))
        for length in (1, 0x10000000):
            reader = asyncio.StreamReader()
            reader.feed_data(bytes([132, 2, 0, 0]) + struct.pack("<I", length))
            with self.assertRaisesRegex(RuntimeError, "invalid-x11-request-length"):
                await read_request(reader, "<")

    async def test_invalid_handshake_fails_closed_without_forwarding_auth(self):
        _, writer = await asyncio.open_unix_connection(str(self.barrier.path))
        self.clients.append(writer)
        writer.write(b"?" + setup("<")[1:])
        await writer.drain()
        error = await asyncio.wait_for(self.barrier.failure, 2)
        self.assertEqual(str(error), "invalid-x11-byte-order")
        await self.close()
        self.assertEqual([packet for record in self.records for packet in record], [])

    async def test_incomplete_handshake_is_closed_without_waiting_for_more_bytes(self):
        _, writer = await asyncio.open_unix_connection(str(self.barrier.path))
        self.clients.append(writer)
        writer.write(setup("<")[:8])
        await writer.drain()
        await self.close()
        self.assertFalse(self.barrier.tasks)
        self.assertEqual([packet for record in self.records for packet in record], [])

    async def test_only_exact_target_event_or_unicode_mapping_matches(self):
        for order in ("<", ">"):
            for mode, key, kind in (("held", 38, 2), ("modifier", 50, 2), ("button", 1, 4)):
                self.assertTrue(matches_request(event(order, kind, key), order, 132, mode, {key}))
                self.assertFalse(matches_request(event(order, kind + 1, key), order, 132, mode, {key}))
                self.assertFalse(matches_request(event(order, kind, key, 131), order, 132, mode, {key}))
            packet = bytes([100, 1]) + struct.pack(order + "H", 3) + bytes([248, 1, 0, 0]) + struct.pack(order + "I", 0x1004e2d)
            self.assertTrue(matches_request(packet, order, 132, "unicode", set()))
            self.assertFalse(matches_request(packet[:-4] + bytes(4), order, 132, "unicode", set()))


class StopTest(unittest.IsolatedAsyncioTestCase):
    async def test_stop_requires_stable_thread_identity_and_all_threads_stopped(self):
        spec = importlib.util.spec_from_file_location("interrupt", Path(__file__).with_name("gui-interrupt-probe.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        states = [{"2/2": ("R", "10")}, {"2/2": ("T", "10")},
                  {"2/2": ("T", "10"), "2/3": ("R", "11")},
                  {"2/2": ("T", "10"), "2/3": ("T", "11")}]
        states.append(states[-1])
        with patch.object(module, "validate"), patch.object(module, "group_threads", side_effect=states):
            self.assertEqual(await module.stopped_group(2, "10", module.time.monotonic() + 2), states[-1])
        with patch.object(module, "validate"), patch.object(module, "group_threads", return_value={"2/2": ("R", "10")}):
            with self.assertRaisesRegex(RuntimeError, "stop-unconfirmed"):
                await module.stopped_group(2, "10", module.time.monotonic())


if __name__ == "__main__":
    unittest.main()
