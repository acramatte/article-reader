"""Run real inference checks; --quick is the bounded CI smoke, full mode is manual."""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("image", nargs="?", default="article-reader-pocket-tts:local")
parser.add_argument("--quick", action="store_true", help="Short synthesis for all voices; skip long-input, repeated and concurrency probes")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
container = subprocess.check_output([
    "docker", "run", "--detach", "--init", "--network", "none", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--memory=4g", "--memory-swap=4g", "--cpus=2",
    "--pids-limit=128", "--tmpfs", "/tmp:size=64m,mode=1777,noexec", args.image,
], text=True).strip()
try:
    probe = (root / "pocket-tts-service" / "smoke_test.py").read_text()
    mode = "quick" if args.quick else "full"
    subprocess.run(["docker", "exec", "-i", "--env", f"POCKET_TTS_SMOKE_MODE={mode}", container, "python", "-"],
                   input=probe, text=True, check=True, timeout=300 if args.quick else 900)
    logs = subprocess.check_output(["docker", "logs", container], stderr=subprocess.STDOUT, text=True)
    for text in ("The article reader sends small text chunks", "Hello from Pocket TTS.", "Bonjour, cet article"):
        assert text not in logs, "Request text leaked into service logs"
    print(f"Real inference container {mode} smoke passed; no request-text logging. HF hosting/auth and physical playback not tested.")
except Exception:
    # Keep the container until diagnostics are captured, including an observed OOM kill.
    subprocess.run(["docker", "inspect", "--format", "{{json .State}}", container], check=False)
    subprocess.run(["docker", "logs", container], check=False)
    raise
finally:
    cleanup = subprocess.run(["docker", "rm", "--force", container], stdout=subprocess.DEVNULL)
    if cleanup.returncode:
        print(f"Warning: container cleanup failed for {container}")
