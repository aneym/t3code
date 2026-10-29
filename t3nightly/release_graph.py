from dataclasses import dataclass


@dataclass(frozen=True)
class Stage:
    name: str
    needs: tuple[str, ...]
    host: str


GRAPH = (
    Stage("assemble", (), "studio"),
    Stage("mac-cli", ("assemble",), "studio"),
    Stage("linux-cli", ("assemble",), "ax42"),
    Stage("desktop", ("assemble", "mac-cli"), "studio"),
    Stage("gate", ("linux-cli",), "ax42"),
    Stage("stage-review", ("mac-cli",), "studio"),
    Stage("awaiting-verdict", ("gate", "stage-review", "desktop"), "studio"),
    Stage("install-ax42", ("awaiting-verdict",), "ax42"),
    Stage("install-studio", ("install-ax42",), "studio"),
    Stage("seed-remote-runtimes", ("install-studio",), "studio"),
    Stage("desktop-swap", ("install-studio", "seed-remote-runtimes"), "studio"),
    Stage("publish-feed", ("desktop-swap",), "studio"),
)


def studio_first_graph():
    dependencies = {
        "install-studio": ("awaiting-verdict",),
        "studio-continuation-proof": ("install-studio",),
        "install-ax42": ("studio-continuation-proof",),
        "desktop-swap": ("install-ax42",),
    }
    graph = [stage for stage in GRAPH if not stage.name.startswith("install-") and stage.name not in ("desktop-swap", "publish-feed")]
    graph.extend([
        Stage("install-studio", dependencies["install-studio"], "studio"),
        Stage("studio-continuation-proof", dependencies["studio-continuation-proof"], "studio"),
        Stage("install-ax42", dependencies["install-ax42"], "ax42"),
        Stage("desktop-swap", dependencies["desktop-swap"], "studio"),
        Stage("publish-feed", ("desktop-swap",), "studio"),
    ])
    return tuple(graph)
