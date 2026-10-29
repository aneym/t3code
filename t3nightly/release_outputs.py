import json
from pathlib import Path

from .release_actions import approved
from .release_continuation import require_studio_proof
from .release_timeline import latest_rows
from .release_signatures import verify_archive, verify_desktop_zip
from .release_transport import ssh


def exists(config, name):
    if name == "assemble":
        return config.candidate.is_dir() and (config.run / "assembly.json").is_file()
    if name == "mac-cli":
        archive = config.run / config.archive("darwin-arm64")
        if not archive.is_file() or not config.tree("mac-cli").is_dir():
            return False
        verify_archive(archive)
        return True
    if name == "linux-cli":
        return (config.run / config.archive("linux-x64")).is_file()
    if name == "desktop":
        directory = config.run / "desktop"
        archive = f"T3-Code-{config.version}-arm64.zip"
        if not all((directory / file).is_file() for file in (archive, f"{archive}.blockmap", "nightly-mac.yml")):
            return False
        verify_desktop_zip(directory / archive)
        return True
    if name == "gate":
        verdict = config.run / "gate/verdict.json"
        suite = config.run / "suite/suite.jsonl"
        if not verdict.is_file() or not suite.is_file():
            return False
        rows = [json.loads(line) for line in suite.read_text().splitlines()]
        return json.loads(verdict.read_text()).get("ok") is True and bool(rows) and all(not row.get("exit", 0) for row in rows)
    if name == "stage-review":
        return any((config.run / "shots").glob("*.png"))
    if name == "awaiting-verdict":
        return approved(config) and (config.run / "SHA256SUMS").is_file()
    if name == "studio-continuation-proof":
        require_studio_proof(config)
        return True
    if name in ("install-ax42", "install-studio"):
        directory = "ax42-install" if name == "install-ax42" else "studio-install"
        path = config.run / directory / "last.json"
        if not path.is_file():
            return False
        report = json.loads(path.read_text())
        return report.get("target") == config.version and report.get("outcome") in ("installed", "current")
    if name == "seed-remote-runtimes":
        return False
    if name == "desktop-swap":
        import plistlib

        path = Path("/Applications/T3 Dev.app/Contents/Info.plist")
        if not path.is_file():
            return False
        with path.open("rb") as handle:
            return plistlib.load(handle).get("CFBundleShortVersionString") == config.version
    if name == "publish-feed":
        path = config.feed / "releases.json"
        return path.is_file() and any(row["version"] == config.version for row in json.loads(path.read_text())["releases"])
    return False


def completed(config, graph):
    rows = latest_rows(config.run / "timeline.jsonl")
    done = set()
    for stage in graph:
        row = rows.get(stage.name, {})
        if row.get("exit") == 0 and all(parent in done for parent in stage.needs) and valid_output(config, stage.name):
            done.add(stage.name)
    return done


def remote_archive_exists(config, log):
    return ssh(["test", "-f", f"{config.remote_run}/{config.archive('linux-x64')}"], log) == 0


def valid_output(config, name):
    try:
        return exists(config, name)
    except (OSError, ValueError, KeyError, TypeError):
        return False
