#!/usr/bin/env python3
"""功能概述：Linux CI 的真实 GTK 合成窗口，作为截图/AX/输入的独立应用证据。
主要职责：提供未保存文本框和计数按钮；每次 GTK 事件写入应用 UID 的 ledger。
代码库关系：check-gui-container.py 仅以 UID1001 启动；不访问控制 socket 或模型。
输入输出与副作用：固定合成内容写 /home/app/gui-ledger.json，窗口关闭退出。
"""
import json
import os
from pathlib import Path
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

if os.getuid() != 1001:
    raise RuntimeError("fixture-app-uid-required")
window = Gtk.Window(title="Kaguya GUI acceptance")
window.set_default_size(600, 300)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=20)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name("Unsaved text")
button = Gtk.Button(label="Increment once")
count = 0


def save(*_args):
    Path("/home/app/gui-ledger.json").write_text(json.dumps({"uid": os.getuid(), "pid": os.getpid(), "text": entry.get_text(), "count": count}))


def increment(_button):
    global count
    count += 1
    save()


entry.connect("changed", save)
button.connect("clicked", increment)
box.pack_start(entry, False, False, 0)
box.pack_start(button, False, False, 0)
window.connect("destroy", Gtk.main_quit)
window.show_all()
save()
Gtk.main()
