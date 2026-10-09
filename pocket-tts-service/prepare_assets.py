"""Stage pinned public models and voice states; runtime needs no network or token."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import sys

from huggingface_hub import hf_hub_download
from pocket_tts.utils.config import CONFIGS_DIR
from pocket_tts.utils.utils import get_predefined_voice
import yaml

REPO = "kyutai/pocket-tts-without-voice-cloning"
VOICES = {"english": ("jane", "bill_boerst"), "french": ("estelle",)}


def prepare(destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    voice_revisions = {}
    def download(url):
        source, revision = url.rsplit("@", 1)
        filename = source.removeprefix(f"hf://{REPO}/")
        target = destination / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(hf_hub_download(REPO, filename, revision=revision, token=False), target)
        return str(target)

    for language, voices in VOICES.items():
        config = yaml.safe_load((CONFIGS_DIR / f"{language}.yaml").read_text())
        # Select the public, non-cloning checkpoint explicitly, never attempt gated weights.
        config["weights_path"] = download(config["weights_path_without_voice_cloning"])
        config["weights_path_without_voice_cloning"] = None
        lookup = config["flow_lm"]["lookup_table"]
        lookup["tokenizer_path"] = download(lookup["tokenizer_path"])
        (destination / f"{language}.yaml").write_text(yaml.safe_dump(config))
        for voice in voices:
            # Voice states are model-dependent; use the same installed release's pins.
            url = get_predefined_voice(language, voice)
            download(url)
            voice_revisions[voice] = url.rsplit("@", 1)[1]
    download(f"hf://{REPO}/README.md@{voice_revisions['jane']}")
    hashes = {}
    for path in sorted(destination.rglob("*")):
        if path.is_file() and path.name != "assets.json":
            with path.open("rb") as source:
                hashes[str(path.relative_to(destination))] = hashlib.file_digest(source, "sha256").hexdigest()
    (destination / "assets.json").write_text(json.dumps({"repo": REPO,
        "pocket_tts_version": importlib.metadata.version("pocket-tts"),
        "voice_revisions": voice_revisions, "sha256": hashes}, indent=2))


if __name__ == "__main__":
    prepare(sys.argv[1])
