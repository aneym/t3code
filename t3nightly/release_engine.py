from pathlib import Path

from .release_manifest import engine_identity, load


def require_engine(manifest, engine=Path(__file__).resolve().parent):
    expected = load(manifest)["engine"]["digest"]
    actual = engine_identity(engine)["digest"]
    if actual != expected:
        raise ValueError(f"engine digest mismatch: candidate.json engine.digest={expected}, engine {engine} digest={actual}; use the frozen candidate engine")
    return expected
