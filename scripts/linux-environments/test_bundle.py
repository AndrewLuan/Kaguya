"""功能概述：以临时合成归档验证安装包校验与不可覆盖 staging，不执行 sudo、Podman 或网络。
主要职责：校验源码/镜像遗漏与篡改、路径注入、符号链接和同 hash 的重入；错误必须在系统变更前拒绝。
代码库关系：直接调用生产 install_bundle.py；真实 Linux 安装由人工审核后的包另行验收。
"""
import json
from pathlib import Path
import tempfile
import unittest
import install_bundle as bundle


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = {"version": 1, "commit": "a" * 40, "sources": {}, "images": {}}
        for name in bundle.SOURCE_FILES:
            (self.root / name).write_text("synthetic source " + name)
            self.manifest["sources"][name] = bundle.digest(self.root / name)
        for role in bundle.IMAGE_ROLES:
            name = role + "-tools.oci"
            (self.root / name).write_bytes(b"synthetic OCI " + role.encode())
            self.manifest["images"][role] = {"file": name, "archiveSha256": bundle.digest(self.root / name)}
        self.save()

    def save(self):
        (self.root / "manifest.json").write_text(json.dumps(self.manifest))

    def test_source_and_each_image_must_match(self):
        self.assertEqual(bundle.verify_manifest(self.root), self.manifest)
        (self.root / "gui-tools.oci").write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "image-checksum-mismatch"):
            bundle.verify_manifest(self.root)
        # 回退不依赖镜像仍在，也必须检查原始宿主代码。
        self.assertEqual(bundle.verify_manifest(self.root, images=False), self.manifest)
        (self.root / "bootstrap.py").write_text("changed")
        with self.assertRaisesRegex(RuntimeError, "source-checksum-mismatch"):
            bundle.verify_manifest(self.root, images=False)

    def test_missing_source_and_archive_path_injection_fail_closed(self):
        source = self.manifest["sources"].pop("job_runner.py")
        self.save()
        with self.assertRaisesRegex(RuntimeError, "manifest-invalid"):
            bundle.verify_manifest(self.root)
        self.manifest["sources"]["job_runner.py"] = source
        self.manifest["images"]["gui"]["file"] = "../gui-tools.oci"
        self.save()
        with self.assertRaisesRegex(RuntimeError, "image-path-invalid"):
            bundle.verify_manifest(self.root)

    def test_stage_reuses_equal_archive_but_rejects_mutation_and_symlink(self):
        inbox = self.root / "inbox"
        inbox.mkdir()
        image = self.manifest["images"]["gui"]
        bundle.stage_image(self.root, image, inbox)
        target = inbox / (image["archiveSha256"] + ".oci")
        inode = target.stat().st_ino
        bundle.stage_image(self.root, image, inbox)
        self.assertEqual(target.stat().st_ino, inode)
        target.write_bytes(b"partial")
        with self.assertRaisesRegex(RuntimeError, "existing-inbox-checksum-mismatch"):
            bundle.stage_image(self.root, image, inbox)
        target.unlink()
        target.symlink_to(self.root / image["file"])
        with self.assertRaisesRegex(RuntimeError, "nonregular-file"):
            bundle.stage_image(self.root, image, inbox)

    def test_linked_source_is_not_accepted(self):
        path = self.root / "server.py"
        path.unlink()
        path.symlink_to(self.root / "broker.py")
        with self.assertRaisesRegex(RuntimeError, "nonregular-file"):
            bundle.verify_manifest(self.root)


if __name__ == "__main__":
    unittest.main()
