import json
from pathlib import Path


def installed_receipt(path, host, version):
    try:
        receipt = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(receipt, dict) or receipt.get("host") != host or receipt.get("release") != version:
        return None
    if receipt.get("outcome") not in ("installed", "current") or (receipt.get("servingRuntime") or {}).get("version") != version:
        return None
    return receipt


def serving_assembly_head(runs, host, version):
    runs = Path(runs)
    receipts = [*runs.glob(f"receipts/install-{host}.json"), *runs.glob(f"*/receipts/install-{host}.json")]
    installed = sorted(((receipt.get("finishedAt") or "", path) for path in receipts if (receipt := installed_receipt(path, host, version))), reverse=True)
    for path in (*(path.parent.parent / "assembly.json" for _, path in installed), runs / "fast/assembly.json", runs / "assembly.json"):
        if path.is_file():
            try:
                return json.loads(path.read_text()).get("head")
            except (OSError, ValueError, AttributeError):
                return None
    return None
