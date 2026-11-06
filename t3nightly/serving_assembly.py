import json
from pathlib import Path


def serving_assembly_head(runs):
    runs = Path(runs)
    receipts = [*runs.glob("receipts/install-*.json"), *runs.glob("*/receipts/install-*.json")]
    installed = [path.parent.parent / "assembly.json" for path in sorted(receipts, key=lambda path: path.stat().st_mtime, reverse=True)]
    for path in (*installed, runs / "fast/assembly.json", runs / "assembly.json"):
        if path.is_file():
            try:
                return json.loads(path.read_text()).get("head")
            except (OSError, ValueError, AttributeError):
                return None
    return None
