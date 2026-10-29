import subprocess
import sys
import threading
import tempfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def serve_assets(directory, version):
    root = Path(tempfile.mkdtemp(prefix="t3nightly-assets-"))
    (root / f"v{version}").symlink_to(Path(directory).expanduser().resolve())
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


def check_served_assets(url, version):
    platform = "darwin-arm64" if sys.platform == "darwin" else "linux-x64"
    name = f"t3-{version}-{platform}.tar.gz"
    with tempfile.TemporaryDirectory(prefix="t3nightly-fetch-check-") as raw:
        for asset in ("SHA256SUMS", name):
            subprocess.run(["curl", "--fail", "--silent", "--show-error", "--max-time", "240", f"{url}/v{version}/{asset}", "-o", str(Path(raw) / asset)], check=True, timeout=240)
        command = ["sha256sum", "-c"]
        subprocess.run([*command, str(Path(raw) / "SHA256SUMS")], cwd=raw, check=True, timeout=240)
