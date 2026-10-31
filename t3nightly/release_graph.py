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


INSTALL_OUTCOMES = ("installed", "current", "rolled-back", "failed")
SUCCESS_OUTCOMES = ("installed", "current")
STAGE_OUTCOMES = ("passed", "failed", "environment-blocked", "timed-out")


@dataclass(frozen=True)
class FastNode:
    id: str
    name: str
    host: str
    needs: tuple[str, ...]
    budget: int
    resources: tuple[str, ...]
    gating: bool = True
    outcomes: tuple[str, ...] = STAGE_OUTCOMES


FAST_GRAPH = (
    FastNode("Q", "readiness", "studio", (), 30, ("release-coordinator",)),
    FastNode("A", "assemble", "studio", ("Q",), 15, ("candidate-assembly",)),
    FastNode("M", "mac-cli", "studio", ("A",), 330, ("build-tree:mac-cli", "mac-signing")),
    FastNode("L", "linux-cli", "ax42", ("A",), 300, ("build-tree:linux-cli",)),
    FastNode("PM", "prepare-sandbox-studio", "studio", ("A",), 60, ("sandbox:studio",)),
    FastNode("PL", "prepare-sandbox-ax42", "ax42", ("A",), 60, ("sandbox:ax42",)),
    FastNode("RM", "rehearse-studio", "studio", ("M", "PM"), 150, ("sandbox:studio",)),
    FastNode("RL", "rehearse-ax42", "ax42", ("L", "PL"), 150, ("sandbox:ax42",)),
    FastNode("XM", "rollback-proof-studio", "studio", ("M", "PM", "RM"), 150, ("rollback-sandbox:studio",)),
    FastNode("XL", "rollback-proof-ax42", "ax42", ("L", "PL", "RL"), 150, ("rollback-sandbox:ax42",)),
    FastNode("D", "desktop", "studio", ("M",), 330, ("build-tree:desktop", "mac-signing")),
    FastNode("EM", "e2e-studio", "studio", ("M",), 300, ("e2e:studio",)),
    FastNode("EL", "e2e-ax42", "ax42", ("L",), 360, ("e2e:ax42",)),
    FastNode("IM", "install-studio", "studio", ("RM", "EM", "XM"), 180, ("live-install:studio",), outcomes=INSTALL_OUTCOMES),
    FastNode("IL", "install-ax42", "ax42", ("RL", "EL", "XL"), 1200, ("live-install:ax42",), outcomes=INSTALL_OUTCOMES),
    FastNode("S", "desktop-swap", "studio", ("D", "IM"), 5, ("desktop-app:studio",)),
    FastNode("F", "publish-feed", "studio", ("S", "IL"), 15, ("feed",)),
    FastNode("LM", "link-mesh", "studio", ("IM", "IL"), 60, ("link-mesh",), gating=False),
    FastNode("LR", "land-receipts", "studio", ("IM", "IL"), 60, (), gating=False),
    FastNode("H", "health-watch", "studio", ("F",), 600, (), gating=False),
    FastNode("AS", "advisory-suites", "studio", ("F",), 3600, (), gating=False),
    FastNode("W", "desktop-windows", "studio", ("A",), 1500, ("build-host:pc",), gating=False),
    FastNode("FW", "publish-windows", "studio", ("F", "W"), 30, ("feed",), gating=False),
)

FAST_DEADLINE = 900


def critical_path(nodes=FAST_GRAPH):
    finish, previous = {}, {}
    for node in nodes:
        if not node.gating:
            continue
        start, before = 0, None
        for need in node.needs:
            if need not in finish:
                raise ValueError(f"{node.id} needs {need}, which is advisory, unknown or listed later")
            if finish[need] > start:
                start, before = finish[need], need
        finish[node.id], previous[node.id] = start + node.budget, before
    last = max(finish, key=lambda node: finish[node])
    path = [last]
    while previous[path[-1]]:
        path.append(previous[path[-1]])
    return tuple(reversed(path)), finish[last]
