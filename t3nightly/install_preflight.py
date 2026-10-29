import hashlib
import shutil
import sys
import tempfile
import urllib.request
from contextlib import contextmanager
from pathlib import Path

from .release_approval import require_approval, require_archive_smoke, verdict_path
from .release_signatures import verify_archive


@contextmanager
def checked_assets(args):
    if not args.hard:
        require_approval(args.version, verdict_path(args.version, args.verdict), Path(args.assets).expanduser() / "shots" if args.assets else None)
    platform = "darwin-arm64" if sys.platform == "darwin" else "linux-x64"
    name = f"t3-{args.version}-{platform}.tar.gz"
    with tempfile.TemporaryDirectory(prefix="t3nightly-install-check-") as raw:
        directory = Path(raw)
        archive = directory / name
        if args.assets:
            source = Path(args.assets).expanduser() / name
            shutil.copy2(source, archive)
        else:
            url = f"{args.base_url.rstrip('/')}/v{args.version}/{name}"
            with urllib.request.urlopen(url, timeout=240) as source, archive.open("wb") as output:
                shutil.copyfileobj(source, output)
        verify_archive(archive)
        expected = Path(args.assets).expanduser() / "SHA256SUMS" if args.assets else None
        if expected and expected.is_file():
            rows = expected.read_text().splitlines()
            match = next((line.split()[0] for line in rows if line.endswith(name)), None)
            digest = hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()
            if match != digest:
                raise ValueError("release checksum does not match the downloaded archive")
        with archive.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        require_archive_smoke(args.version, verdict_path(args.version, args.verdict), name, digest)
        (directory / "SHA256SUMS").write_text(f"{digest}  {name}\n")
        yield directory
