"""Fetch only pinned public Kokoro assets at image build time, never at service startup."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
from urllib.request import urlopen

from huggingface_hub import snapshot_download

REPO = "hexgrad/Kokoro-82M"
REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
WEIGHT_SHA256 = "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4"
FILES = ["config.json", "kokoro-v1_0.pth", "voices/af_heart.pt", "voices/af_bella.pt", "voices/af_nicole.pt", "README.md", "VOICES.md"]

if __name__ == "__main__":
    destination = Path(sys.argv[1])
    snapshot_download(REPO, revision=REVISION, allow_patterns=FILES, local_dir=destination, token=False)
    hashes = {}
    for filename in FILES:
        with (destination / filename).open("rb") as source:
            hashes[filename] = hashlib.file_digest(source, "sha256").hexdigest()
    if hashes["kokoro-v1_0.pth"] != WEIGHT_SHA256:
        raise RuntimeError("Kokoro weight checksum mismatch")
    with urlopen("https://www.apache.org/licenses/LICENSE-2.0.txt", timeout=30) as response:
        (destination / "LICENSE-2.0.txt").write_bytes(response.read())
    (destination / "assets.json").write_text(json.dumps({"repo": REPO, "revision": REVISION, "sha256": hashes}, indent=2))
    shutil.rmtree(destination / ".cache", ignore_errors=True)
