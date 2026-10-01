"""Start and remove a hardened, network-isolated container; test actual inference over loopback."""
from pathlib import Path
import subprocess
import sys

image = sys.argv[1] if len(sys.argv) > 1 else "article-reader-kokoro:local"
root = Path(__file__).resolve().parents[1]
container = subprocess.check_output([
    "docker", "run", "--detach", "--rm", "--init", "--network", "none", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--memory=4g", "--memory-swap=4g", "--cpus=2",
    "--pids-limit=128", "--tmpfs", "/tmp:size=64m,mode=1777", image,
], text=True).strip()
try:
    probe = (root / "kokoro-service" / "smoke_test.py").read_text()
    subprocess.run(["docker", "exec", "-i", container, "python", "-"], input=probe, text=True, check=True, timeout=240)
    logs = subprocess.check_output(["docker", "logs", container], stderr=subprocess.STDOUT, text=True)
    assert "The article reader sends small text chunks" not in logs, "Request text leaked into service logs"
    print("Real inference container smoke passed; no request-text logging. HF hosting/auth and physical playback not tested.")
except Exception:
    subprocess.run(["docker", "logs", container], check=False)
    raise
finally:
    subprocess.run(["docker", "stop", container], stdout=subprocess.DEVNULL, check=True)
