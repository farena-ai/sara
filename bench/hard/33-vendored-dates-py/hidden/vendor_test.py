import hashlib
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "..", "vendor")


def files(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ("__pycache__", "node_modules")]
        for name in filenames:
            if name.endswith(".pyc"):
                continue
            out.append(os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/"))
    return sorted(out)


def digest(path):
    with open(path, encoding="utf-8", newline="") as f:
        text = f.read().replace("\r\n", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class VendorUnchanged(unittest.TestCase):
    def test_the_vendored_library_under_vendor_is_unchanged(self):
        with open(os.path.join(HERE, "vendor.sha256"), encoding="utf-8") as f:
            expected = [line.split() for line in f.read().splitlines() if line.strip()]
        self.assertEqual(files(VENDOR), sorted(name for _, name in expected), "vendor/ has the same files")
        for checksum, name in expected:
            self.assertEqual(digest(os.path.join(VENDOR, name)), checksum, f"vendor/{name} is unchanged")


if __name__ == "__main__":
    unittest.main()
