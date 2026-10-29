import argparse
import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .release_graph import GRAPH


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
