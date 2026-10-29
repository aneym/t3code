import hashlib
import json
import re
from pathlib import Path


def verdict_path(version, explicit=None):
    if explicit:
        return Path(explicit).expanduser()
    if re.fullmatch(r"[0-9A-Za-z.+-]+\.aneym\.[0-9]+", version) is None:
        raise ValueError("approval requires a full fork nightly version")
    return Path.home() / ".agent-rails/lanes/t3-nightly" / f"aneym{version.rsplit('.', 1)[1]}" / "visual-verdict.md"


def smoke_record(verdict, archive_name):
    return Path(verdict).parent / "smoke" / f"{archive_name}.json"


def file_sha256(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def release_archives(version, shots_dir):
    roots = [Path(shots_dir).parent] if shots_dir is not None else []
    roots.append(Path.home() / ".t3nightly/runs" / version)
    prefix = f"t3-{version}-"
    archives = {}
    for root in roots:
        sums = root / "SHA256SUMS"
        if sums.is_file():
            for row in (line.split() for line in sums.read_text().splitlines() if line.strip()):
                if row[-1].startswith(prefix) and row[-1].endswith(".tar.gz"):
                    archives.setdefault(row[-1], set()).add(row[0])
        for path in sorted(root.glob(f"{prefix}*.tar.gz")) if root.is_dir() else []:
            archives.setdefault(path.name, set()).add(file_sha256(path))
    if not archives:
        raise ValueError("smoke gate found no release archives or SHA256SUMS for %s" % version)
    conflicting = sorted(name for name, digests in archives.items() if len(digests) > 1)
    if conflicting:
        raise ValueError("release archive bytes do not match SHA256SUMS: %s" % ", ".join(conflicting))
    return {name: digests.pop() for name, digests in archives.items()}


def require_archive_smoke(version, verdict, name, digest):
    record = smoke_record(verdict, name)
    try:
        smoke = json.loads(record.read_text())
    except (OSError, ValueError) as error:
        raise ValueError(f"no smoke verdict for {name} at {record}") from error
    if smoke.get("version") != version or smoke.get("archiveSha256") != digest:
        raise ValueError(f"smoke verdict {record} is for another build")
    if smoke.get("ok") is not True:
        failed = [step["name"] for step in smoke.get("steps") or [] if not step.get("ok")]
        raise ValueError(f"smoke failed for {name}: {', '.join(failed) or 'not ok'}")


def require_smoke(version, verdict, shots_dir=None):
    for name, digest in release_archives(version, shots_dir).items():
        require_archive_smoke(version, verdict, name, digest)


def require_approval(version, verdict, shots_dir=None):
    verdict = Path(verdict)
    try:
        lines = verdict.read_text().splitlines()
        if not lines or lines[0] != f"APPROVED {version}":
            raise ValueError("approval first line must be APPROVED followed by the full version")
        roots = [verdict.parent / "shots", Path.home() / ".t3nightly/runs" / version / "shots"]
        if shots_dir is not None:
            roots.append(Path(shots_dir))
        shots = [path for root in roots for path in root.rglob("*") if path.is_file()]
        if not shots or verdict.stat().st_mtime_ns <= max(path.stat().st_mtime_ns for path in shots):
            raise ValueError("approval must be newer than every adjacent shot")
    except OSError as error:
        raise ValueError("approval or adjacent shots are missing or unreadable") from error
    require_smoke(version, verdict, shots_dir)


def approved(config):
    try:
        require_approval(config.version, config.verdict, config.run / "shots")
        return True
    except ValueError:
        return False
