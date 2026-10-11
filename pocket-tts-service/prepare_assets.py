"""Stage pinned public models and voice states; runtime needs no network or token.

assets.json traces every staged file to its source. Downloaded files record the
Hugging Face repository, path, exact commit and the Hub-published hash they were
verified against. Configurations rewritten for offline use record the installed
pocket-tts package file they came from and each rewritten key.
"""
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import shutil
import sys

from huggingface_hub import HfApi, hf_hub_download
from pocket_tts.utils.config import CONFIGS_DIR
from pocket_tts.utils.utils import get_predefined_voice
import yaml

REPO = "kyutai/pocket-tts-without-voice-cloning"
VOICES = {"english": ("jane", "bill_boerst"), "french": ("estelle",)}
# Source recordings that the shipped model card lists for each voice state, and
# the tts-voices commit whose README states their licenses. They are not bundled.
VOICE_SOURCES_REPO = "kyutai/tts-voices"
VOICE_SOURCES_REVISION = "323332d33f997de8394f24a193e1a76df720e01a"
VOICE_SOURCES = {
    "jane": ("vctk/p339_023_enhanced.wav", "cc-by-4.0"),
    "bill_boerst": ("voice-zero/bill_boerst.wav", "cc0-1.0"),
    "estelle": ("unmute-prod-website/developpeuse-3.wav", "cc0-1.0"),
}
COMMIT = re.compile(r"[0-9a-f]{40}")


def sha256(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def git_blob_id(path):
    data = path.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def prepare(destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    api = HfApi(token=False)
    assets = {}
    cards = {}

    def model_card(revision):
        # Each file's license comes from the model card at that file's own commit.
        if revision not in cards:
            info = api.model_info(REPO, revision=revision)
            assert info.sha == revision, f"{revision} is not an exact {REPO} commit"
            (readme,) = api.get_paths_info(REPO, ["README.md"], revision=revision)
            cards[revision] = {"license": info.card_data["license"],
                               "model_card": {"path": "README.md", "revision": revision, "git_blob_id": readme.blob_id}}
        return cards[revision]

    def download(url, role, pinned_by, **details):
        source, revision = url.rsplit("@", 1)
        path = source.removeprefix(f"hf://{REPO}/")
        assert path != source and COMMIT.fullmatch(revision), f"Unpinned or foreign asset: {url}"
        assert path not in assets, f"Conflicting staged path: {path}"
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(hf_hub_download(REPO, path, revision=revision, token=False), target)
        (remote,) = api.get_paths_info(REPO, [path], revision=revision)
        digest, size = sha256(target), target.stat().st_size
        # Verify the staged bytes against what the Hub publishes for this commit.
        assert remote.size == size, f"Size mismatch: {path}"
        if remote.lfs:
            assert remote.lfs.sha256 == digest, f"LFS SHA-256 mismatch: {path}"
        else:
            assert remote.blob_id == git_blob_id(target), f"Git blob mismatch: {path}"
        assets[path] = {"path": path, "kind": "downloaded", "role": role, **details, "sha256": digest, "size": size,
                        "source": {"repo": REPO, "path": path, "revision": revision,
                                   "url": f"https://huggingface.co/{REPO}/resolve/{revision}/{path}",
                                   "storage": "lfs" if remote.lfs else "git", "git_blob_id": remote.blob_id,
                                   "sha256": digest, "size": size, "pinned_by": pinned_by},
                        **model_card(revision)}
        return str(target)

    package = importlib.metadata.distribution("pocket-tts")
    record = {file.as_posix(): file.hash.value for file in package.files if file.hash}
    voice_revisions = set()
    for language, voices in VOICES.items():
        config_file = CONFIGS_DIR / f"{language}.yaml"
        package_path = config_file.resolve().relative_to(Path(package.locate_file("")).resolve()).as_posix()
        raw = config_file.read_bytes()
        assert record[package_path] == base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).rstrip(b"=").decode(), \
            f"Installed {package_path} differs from the pocket-tts wheel RECORD"
        config = yaml.safe_load(raw)
        lookup = config["flow_lm"]["lookup_table"]
        pinned_by = f"{package_path}:%s"
        rewrites = [
            # Select the public, non-cloning checkpoint explicitly, never attempt gated weights.
            {"key": "weights_path", "from": config["weights_path"],
             "to": download(config["weights_path_without_voice_cloning"], "model-weights",
                            pinned_by % "weights_path_without_voice_cloning", language=language)},
            {"key": "weights_path_without_voice_cloning", "from": config["weights_path_without_voice_cloning"], "to": None},
            {"key": "flow_lm.lookup_table.tokenizer_path", "from": lookup["tokenizer_path"],
             "to": download(lookup["tokenizer_path"], "tokenizer", pinned_by % "flow_lm.lookup_table.tokenizer_path",
                            language=language)},
        ]
        config["weights_path"], config["weights_path_without_voice_cloning"] = rewrites[0]["to"], None
        lookup["tokenizer_path"] = rewrites[2]["to"]
        target = destination / f"{language}.yaml"
        target.write_text(yaml.safe_dump(config))
        assert yaml.safe_load(target.read_text()) == config
        assets[target.name] = {
            "path": target.name, "kind": "rewritten", "role": "model-config", "language": language,
            "sha256": sha256(target), "size": target.stat().st_size,
            "source": {"package": "pocket-tts", "version": package.version, "path": package_path,
                       "sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw)},
            "rewrites": rewrites,
            "note": "Only the listed keys differ; re-serialized with yaml.safe_dump, so comments and key order are not preserved.",
        }
        for voice in voices:
            # Voice states are model-dependent; use the same installed release's pins.
            url = get_predefined_voice(language, voice)
            download(url, "voice-state", "pocket_tts.utils.utils.get_predefined_voice", language=language, voice=voice)
            voice_revisions.add(url.rsplit("@", 1)[1])

    (voice_revision,) = voice_revisions
    card = download(f"hf://{REPO}/README.md@{voice_revision}", "model-card", "voice-state revision")
    card_text = Path(card).read_text()
    info = api.model_info(VOICE_SOURCES_REPO, revision=VOICE_SOURCES_REVISION)
    assert info.sha == VOICE_SOURCES_REVISION, f"{VOICE_SOURCES_REVISION} is not an exact {VOICE_SOURCES_REPO} commit"
    remote = {entry.path: entry for entry in api.get_paths_info(
        VOICE_SOURCES_REPO, ["README.md", *(path for path, _ in VOICE_SOURCES.values())], revision=VOICE_SOURCES_REVISION)}
    for asset in assets.values():
        if asset["role"] == "voice-state":
            path, voice_license = VOICE_SOURCES[asset["voice"]]
            listing = f"* [{asset['voice']}](https://huggingface.co/{VOICE_SOURCES_REPO}/blob/main/{path})"
            assert listing in card_text, f"Shipped model card does not list {listing}"
            asset["source_recording"] = {
                "repo": VOICE_SOURCES_REPO, "path": path, "revision": VOICE_SOURCES_REVISION,
                "sha256": remote[path].lfs.sha256, "size": remote[path].size, "license": voice_license,
                "license_document": {"path": "README.md", "git_blob_id": remote["README.md"].blob_id},
                "listed_in": {"path": "README.md", "revision": voice_revision},
                "bundled": False,
            }

    staged = sorted(path.relative_to(destination).as_posix() for path in destination.rglob("*")
                    if path.is_file() and path.name != "assets.json")
    assert staged == sorted(assets), "Staged files and manifest differ"
    (destination / "assets.json").write_text(json.dumps({
        "schema_version": 2, "pocket_tts_version": package.version,
        "assets": [assets[path] for path in staged],
    }, indent=2) + "\n")


if __name__ == "__main__":
    prepare(sys.argv[1])
