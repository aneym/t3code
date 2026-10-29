import argparse
import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .release_graph import GRAPH


HOSTS = {
    "studio": {"repo": Path("/Volumes/StudioExt/repos/t3code"), "trees": Path("/Volumes/StudioExt/repos/t3code-wt"), "key": "darwin-arm64"},
    "ax42": {"repo": Path("/home/jobs/repos/t3code"), "trees": Path("/home/jobs/repos/t3code-wt"), "key": "linux-x64"},
}
CHAT_PROJECT = ".t3nightly/fast-chat-project"
SEEDS = ".t3nightly/rehearsal-seeds"


@dataclass(frozen=True)
class Config:
    version: str
    base: str
    topics: Path
    repo: Path
    candidate: Path
    run: Path
    lane: Path
    remote_repo: str
    remote_root: str
    tools: Path
    feed: Path
    approval: Path | None
    owned_trees: dict[Path, str] = field(default_factory=dict, compare=False)

    @property
    def number(self):
        return self.version.rsplit(".", 1)[1]

    @property
    def verdict(self):
        return self.approval or self.lane / f"aneym{self.number}" / "visual-verdict.md"

    @property
    def remote_run(self):
        return f"{self.remote_root}/runs/{self.version}"

    @property
    def remote_tree(self):
        return f"/home/jobs/repos/t3code-wt/aneym-nightly-candidate-{self.number}"

    def tree(self, stage):
        return self.candidate.with_name(f"{self.candidate.name}-{stage}")

    def archive(self, platform):
        return f"t3-{self.version}-{platform}.tar.gz"

    def identity(self):
        return {
            "version": self.version, "base": self.base,
            "topics": hashlib.sha256(self.topics.read_bytes()).hexdigest(),
            "repo": str(self.repo), "candidate": str(self.candidate),
            "lane": str(self.lane), "remote_repo": self.remote_repo,
            "remote_root": self.remote_root, "feed": str(self.feed),
        }

    def bind(self):
        self.run.mkdir(parents=True, exist_ok=True)
        path = self.run / "inputs.json"
        value = self.identity()
        if path.exists() and json.loads(path.read_text()) != value:
            raise ValueError("run inputs changed; use a new version")
        path.write_text(json.dumps(value, indent=2) + "\n")


@dataclass(frozen=True)
class FastConfig:
    version: str
    topic: str
    run: Path
    host: str
    remote_run: str
    remote_tools: str
    base: str = ""

    @property
    def number(self):
        return self.version.rsplit(".", 1)[1]

    @property
    def nightly(self):
        return self.version.split(".aneym.", 1)[0]

    @property
    def tools(self):
        return Path(__file__).resolve().parent

    @property
    def repo(self):
        return HOSTS[self.host]["repo"]

    @property
    def key(self):
        return HOSTS[self.host]["key"]

    @property
    def home(self):
        return Path.home() if self.host == "studio" else Path("/home/jobs")

    @property
    def manifest(self):
        return self.run / "candidate.json"

    @property
    def held(self):
        return (self.home / ".t3nightly" / f"hold-install{self.number}").exists()

    def on(self, host):
        run = Path(self.remote_run) if host == "ax42" and self.host == "studio" else self.run
        return FastConfig(self.version, self.topic, run, host, self.remote_run, self.remote_tools, self.base)

    def tree(self, stage):
        return HOSTS[self.host]["trees"] / f"aneym-fast-{stage}"

    def candidate_tree(self):
        return HOSTS[self.host]["trees"] / "aneym-fast-candidate"

    def archive(self, key=None):
        return f"t3-{self.version}-{key or self.key}.tar.gz"

    def build_out(self):
        return self.run / ("mac" if self.host == "studio" else "linux")

    def artifact(self, root=None):
        platform, arch = self.key.split("-")
        return (root or self.build_out()) / f"artifact-{platform}-{arch}.json"

    def sandbox_root(self):
        return self.home / ".t3nightly" / f"rehearsal-fast-{self.number}-{self.host}"

    def receipt(self, kind):
        return self.run / "receipts" / f"{kind}-{self.host}.json"

    def install_state(self):
        return self.run / f"install-{self.host}"

    def outcome(self):
        return self.install_state() / "outcome.json"

    def seed(self, history):
        return self.home / SEEDS / f"{history}.sqlite"

    def chat_project(self):
        return self.home / CHAT_PROJECT


def parse():
    parser = argparse.ArgumentParser(description="Run the fork release DAG; rerun after the visual verdict to resume.")
    parser.add_argument("version")
    parser.add_argument("--base", required=True)
    parser.add_argument("--topics", type=Path, required=True, help="file of branch sha lines")
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--repo", type=Path, default=Path("/Volumes/StudioExt/repos/t3code"))
    parser.add_argument("--lane", type=Path, default=Path.home() / ".agent-rails/lanes/t3-nightly")
    parser.add_argument("--remote-repo", default="/home/jobs/repos/t3code")
    parser.add_argument("--remote-root", default="/home/jobs/t3nightly")
    parser.add_argument("--feed", type=Path, default=Path("/Volumes/StudioExt/t3nightly-feed"))
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--studio-first", action="store_true")
    parser.add_argument("--verdict", type=Path)
    parser.add_argument("--until", choices=[stage.name for stage in GRAPH] + ["studio-continuation-proof"])
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+-nightly\.\d+\.\d+\.aneym\.\d+", args.version):
        parser.error("version must be an upstream nightly plus .aneym.N")
    number = args.version.rsplit(".", 1)[1]
    candidate = args.candidate or Path(f"/Volumes/StudioExt/repos/t3code-wt/aneym-nightly-candidate-{number}")
    config = Config(
        args.version, args.base, args.topics.expanduser().resolve(), args.repo.expanduser().resolve(),
        candidate.expanduser().resolve(), Path.home() / ".t3nightly/runs" / args.version,
        args.lane.expanduser().resolve(), args.remote_repo, args.remote_root,
        Path(__file__).resolve().parent, args.feed.expanduser().resolve(), args.verdict.expanduser().resolve() if args.verdict else None,
    )
    return config, args
