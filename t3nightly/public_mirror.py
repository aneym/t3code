import hashlib
import hmac
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .release_signatures import verify_archive

CONFIG = Path(os.environ.get("T3NIGHTLY_PUBLIC_MIRROR", Path.home() / ".config/t3nightly/public-mirror.json"))
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]+\.[0-9]+\.aneym\.[0-9]+")
ARCHIVE = re.compile(r"t3-(?P<version>[0-9][0-9A-Za-z.+-]*)-(?P<target>(?:darwin|linux)-(?:arm64|x64))\.tar\.gz")
KEEP = 5
EMPTY = hashlib.sha256(b"").hexdigest()
JSON_TYPE = "application/json"


def version_key(version):
    return tuple(int(part) for part in re.findall(r"\d+", version))


def digest(path, name="sha256"):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, name).hexdigest()


def encode(value):
    return (json.dumps(value, indent=2) + "\n").encode()


class Directory:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()

    def describe(self):
        return str(self.root)

    def get(self, key):
        path = self.root / key
        return path.read_bytes() if path.is_file() else None

    def put(self, key, source, content_type):
        target = self.root / key
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as handle:
            temp = Path(handle.name)
            if isinstance(source, Path):
                with source.open("rb") as reader:
                    while chunk := reader.read(1 << 20):
                        handle.write(chunk)
            else:
                handle.write(source)
        try:
            temp.chmod(0o644)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)

    def exists(self, key):
        return (self.root / key).is_file()

    def check(self, key, source):
        path = self.root / key
        if not path.is_file():
            return False
        if isinstance(source, Path):
            return digest(path) == digest(source)
        return path.read_bytes() == source

    def delete(self, key):
        (self.root / key).unlink(missing_ok=True)
        try:
            (self.root / key).parent.rmdir()
        except OSError:
            pass


def agent_secret(name):
    result = subprocess.run([str(Path.home() / ".local/bin/agent-secret"), "get", name], capture_output=True, text=True, check=False)
    if result.returncode or not result.stdout.strip():
        raise ValueError(f"agent-secret {name} is unavailable")
    return result.stdout.strip()


class Bucket:
    def __init__(self, endpoint, bucket, prefix, key_id, secret):
        self.endpoint = endpoint.rstrip("/")
        self.host = urllib.parse.urlsplit(self.endpoint).netloc
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.key_id = key_id
        self.secret = secret

    def describe(self):
        return f"r2://{self.bucket}/{self.prefix}"

    def path(self, key):
        return "/" + urllib.parse.quote(f"{self.bucket}/{self.prefix}/{key}", safe="/-_.~")

    def signed(self, method, key, payload, extra):
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        headers = {**{name.lower(): value for name, value in extra.items()}, "host": self.host, "x-amz-content-sha256": payload, "x-amz-date": stamp}
        names = sorted(headers)
        canonical = "\n".join([method, self.path(key), "", "".join(f"{name}:{str(headers[name]).strip()}\n" for name in names), ";".join(names), payload])
        scope = f"{stamp[:8]}/auto/s3/aws4_request"
        text = "\n".join(["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
        signing = ("AWS4" + self.secret).encode()
        for part in (stamp[:8], "auto", "s3", "aws4_request"):
            signing = hmac.new(signing, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(signing, text.encode(), hashlib.sha256).hexdigest()
        headers["authorization"] = f"AWS4-HMAC-SHA256 Credential={self.key_id}/{scope}, SignedHeaders={';'.join(names)}, Signature={signature}"
        return headers

    def call(self, method, key, payload=EMPTY, body=None, extra=None, missing_ok=False):
        for attempt in range(4):
            data = body.open("rb") if isinstance(body, Path) else body
            try:
                request = urllib.request.Request(self.endpoint + self.path(key), data=data, method=method, headers=self.signed(method, key, payload, extra or {}))
                with urllib.request.urlopen(request, timeout=600) as response:
                    return response.status, dict(response.headers), response.read()
            except urllib.error.HTTPError as error:
                if error.code == 404 and missing_ok:
                    return 404, {}, b""
                if error.code < 500 or attempt == 3:
                    code = re.search(rb"<Code>([A-Za-z]+)</Code>", error.read() or b"")
                    raise ValueError(f"{method} {self.describe()}/{key} answered HTTP {error.code}{' ' + code[1].decode() if code else ''}") from None
            except OSError as error:
                if attempt == 3:
                    raise ValueError(f"{method} {self.describe()}/{key} failed: {type(error).__name__}") from None
            finally:
                if isinstance(body, Path) and data is not None:
                    data.close()
            time.sleep(2 ** attempt)

    def get(self, key):
        status, _, body = self.call("GET", key, missing_ok=True)
        return None if status == 404 else body

    def put(self, key, source, content_type):
        size = source.stat().st_size if isinstance(source, Path) else len(source)
        payload = digest(source) if isinstance(source, Path) else hashlib.sha256(source).hexdigest()
        self.call("PUT", key, payload, source, {"content-type": content_type, "content-length": str(size)})

    def exists(self, key):
        return self.call("HEAD", key, missing_ok=True)[0] != 404

    def check(self, key, source):
        status, headers, _ = self.call("HEAD", key, missing_ok=True)
        if status == 404:
            return False
        lowered = {name.lower(): value for name, value in headers.items()}
        md5 = digest(source, "md5") if isinstance(source, Path) else hashlib.md5(source).hexdigest()
        size = source.stat().st_size if isinstance(source, Path) else len(source)
        return lowered.get("etag", "").strip('"') == md5 and lowered.get("content-length") == str(size)

    def delete(self, key):
        self.call("DELETE", key, missing_ok=True)


def store(config_path=CONFIG, directory=None):
    if directory is not None:
        return Directory(directory)
    config = json.loads(Path(config_path).read_text())
    if config.get("target") == "dir":
        return Directory(config["path"])
    if config.get("target") == "r2":
        return Bucket(config["endpoint"], config["bucket"], config.get("prefix", "t3"), agent_secret(config["keyIdSecret"]), agent_secret(config["secretSecret"]))
    raise ValueError(f"{config_path}: target must be dir or r2")


def configured(config_path=CONFIG):
    return Path(config_path).is_file()


def releases(target):
    raw = target.get("releases.json")
    rows = json.loads(raw)["releases"] if raw else []
    if any(VERSION.fullmatch(row["version"]) is None for row in rows):
        raise ValueError("public releases.json holds an invalid version")
    return rows


def pinned(target):
    raw = target.get("pin.json")
    return json.loads(raw)["version"] if raw else None


def release_files(source, version):
    sums = source / "SHA256SUMS"
    if not sums.is_file():
        raise ValueError(f"missing {sums}")
    rows = dict(reversed(line.split()) for line in sums.read_text().splitlines() if len(line.split()) == 2)
    archives = []
    for path in sorted(source.glob(f"t3-{version}-*.tar.gz")):
        match = ARCHIVE.fullmatch(path.name)
        if match is None or match["version"] != version:
            raise ValueError(f"unexpected archive {path.name}")
        if rows.get(path.name) != digest(path):
            raise ValueError(f"checksum mismatch for {path.name}")
        verify_archive(path)
        archives.append((path, match["target"]))
    if not archives:
        raise ValueError(f"no CLI archives for {version} in {source}")
    if set(rows) != {path.name for path, _ in archives}:
        raise ValueError("SHA256SUMS does not list exactly the CLI archives")
    return sums, archives


def upload(target, key, source, content_type):
    if target.check(key, source):
        return
    target.put(key, source, content_type)
    if not target.check(key, source):
        raise ValueError(f"{target.describe()}/{key} does not match after upload")


def write_pin(target, version):
    row = next((entry for entry in releases(target) if entry["version"] == version), None)
    if row is None:
        raise ValueError(f"{version} is not in the public releases.json")
    keys = [f"v{version}/SHA256SUMS", *(f"v{version}/t3-{version}-{name}.tar.gz" for name in row["cli"])]
    missing = [key for key in keys if not target.exists(key)]
    if missing:
        raise ValueError(f"{version} is incomplete in the mirror: {', '.join(missing)}")
    upload(target, "pin.json", encode({"version": version}), JSON_TYPE)


def mirror(target, source, version, built_at, pin=None):
    if VERSION.fullmatch(version) is None:
        raise ValueError(f"not a fork nightly version: {version}")
    sums, archives = release_files(Path(source), version)
    for path, _ in archives:
        upload(target, f"v{version}/{path.name}", path, "application/gzip")
    upload(target, f"v{version}/SHA256SUMS", sums, "text/plain; charset=utf-8")
    current = pinned(target)
    row = {"version": version, "builtAt": built_at, "cli": sorted(name for _, name in archives), "desktop": []}
    rows = sorted([entry for entry in releases(target) if entry["version"] != version] + [row], key=lambda entry: version_key(entry["version"]), reverse=True)
    pin = pin if pin is not None else rows[0]["version"] == version
    keep = {version if pin else current, *(entry["version"] for entry in rows[:KEEP])}
    kept = [entry for entry in rows if entry["version"] in keep]
    upload(target, "releases.json", encode({"releases": kept}), JSON_TYPE)
    if pin:
        write_pin(target, version)
    for old in rows:
        if old["version"] not in keep:
            for name in old["cli"]:
                target.delete(f"v{old['version']}/t3-{old['version']}-{name}.tar.gz")
            target.delete(f"v{old['version']}/SHA256SUMS")
    return {"mirror": target.describe(), "version": version, "pin": pinned(target), "releases": [entry["version"] for entry in kept]}


def mirror_feed(target, feed, version):
    rows = json.loads((Path(feed) / "releases.json").read_text())["releases"]
    row = next((entry for entry in rows if entry["version"] == version), None)
    if row is None:
        raise ValueError(f"{version} is not in {feed}/releases.json")
    return mirror(target, Path(feed) / f"v{version}", version, row["builtAt"])
