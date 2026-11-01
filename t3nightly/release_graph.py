from dataclasses import dataclass

from .release_targets import LINUX_TARGETS, TARGET_SUFFIXES, linux_target


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


def linux_nodes(host, builder):
    suffix = TARGET_SUFFIXES[host]
    payload = "L" if host == builder else f"T{suffix}"
    transfer = () if host == builder else (FastNode(payload, f"stage-linux-{host}", "studio", ("SL",), 900, (f"payload:{host}",)),)
    return (*transfer,
            FastNode(f"P{suffix}", f"prepare-sandbox-{host}", host, ("A",), 180, (f"sandbox:{host}",)),
            FastNode(f"R{suffix}", f"rehearse-{host}", host, (payload, f"P{suffix}"), 150, (f"sandbox:{host}",)),
            FastNode(f"X{suffix}", f"rollback-proof-{host}", host, (payload, f"P{suffix}", f"R{suffix}"), 150, (f"rollback-sandbox:{host}",)),
            FastNode(f"E{suffix}", f"e2e-{host}", host, (payload, f"P{suffix}"), 360, (f"e2e:{host}",)),
            FastNode(f"I{suffix}", f"install-{host}", host, (f"R{suffix}", f"E{suffix}", f"X{suffix}"), 1200, (f"live-install:{host}",), outcomes=INSTALL_OUTCOMES))


def fast_graph(linux_host="ax42"):
    builder = linux_target(linux_host)
    installs = tuple(f"I{suffix}" for suffix in TARGET_SUFFIXES.values())
    return (
        FastNode("Q", "readiness", "studio", (), 30, ("release-coordinator",)),
        FastNode("A", "assemble", "studio", ("Q",), 30, ("candidate-assembly",)),
        FastNode("M", "mac-cli", "studio", ("A",), 330, ("build-tree:mac-cli", "mac-signing")),
        FastNode("L", "linux-cli", builder, ("A",), 300, ("build-tree:linux-cli",)),
        FastNode("PM", "prepare-sandbox-studio", "studio", ("A",), 60, ("sandbox:studio",)),
        FastNode("RM", "rehearse-studio", "studio", ("M", "PM"), 150, ("sandbox:studio",)),
        FastNode("XM", "rollback-proof-studio", "studio", ("M", "PM", "RM"), 150, ("rollback-sandbox:studio",)),
        FastNode("D", "desktop", "studio", ("M",), 330, ("build-tree:desktop", "mac-signing")),
        FastNode("SM", "prestage-mac", "studio", ("M",), 900, ("prestage:mac",)),
        FastNode("SL", "prestage-linux", "studio", ("L",), 900, ("prestage:linux",)),
        FastNode("SD", "prestage-desktop", "studio", ("D",), 900, ("prestage:desktop",)),
        *(node for host in LINUX_TARGETS for node in linux_nodes(host, builder)),
        FastNode("EM", "e2e-studio", "studio", ("M",), 300, ("e2e:studio",)),
        FastNode("IM", "install-studio", "studio", ("RM", "EM", "XM"), 180, ("live-install:studio",), outcomes=INSTALL_OUTCOMES),
        FastNode("S", "desktop-swap", "studio", ("D", "IM"), 5, ("desktop-app:studio",)),
        FastNode("F", "publish-feed", "studio", ("S", *installs[1:], "SM", "SL", "SD"), 15, ("feed",)),
        FastNode("LM", "link-mesh", "studio", installs, 60, ("link-mesh",), gating=False),
        FastNode("LR", "land-receipts", "studio", (*installs, "F"), 60, (), gating=False),
        FastNode("H", "health-watch", "studio", ("F",), 600, (), gating=False),
        FastNode("AS", "advisory-suites", "studio", ("F",), 3600, (), gating=False),
        FastNode("W", "desktop-windows", "studio", ("A",), 1500, ("build-host:pc",), gating=False),
        FastNode("FW", "publish-windows", "studio", ("F", "W"), 30, ("feed",), gating=False),
    )


FAST_GRAPH = fast_graph()

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
