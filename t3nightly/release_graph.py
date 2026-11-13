from dataclasses import dataclass, replace

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
STAGE_OUTCOMES = ("passed", "failed", "environment-blocked", "timed-out", "cancelled")


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
    defer_reason: str = ""
    writes: tuple[str, ...] = ()


def linux_nodes(host, builder, defer_hosts=(), defer_reason=""):
    suffix = TARGET_SUFFIXES[host]
    if host in defer_hosts:
        return (FastNode(f"I{suffix}", f"install-{host}", host, (), 0, (), outcomes=("deferred",), defer_reason=defer_reason),)
    payload = "L" if host == builder else f"T{suffix}"
    transfer = () if host == builder else (FastNode(payload, f"stage-linux-{host}", builder, ("L",), 900, (f"payload:{host}",), writes=(host,)),)
    return (*transfer,
            FastNode(f"I{suffix}", f"install-{host}", host, (payload,), 1200, (f"live-install:{host}",), outcomes=INSTALL_OUTCOMES))


def fast_graph(linux_host="ax42", defer_hosts=(), defer_reason=""):
    defer_hosts = tuple(defer_hosts or ())
    if bool(defer_hosts) != bool(defer_reason.strip()):
        raise ValueError("deferral requires a host and a nonempty reason")
    if set(defer_hosts) - {"studio", *LINUX_TARGETS}:
        raise ValueError("only Studio and Linux targets can be deferred")
    builder = linux_target(linux_host)
    if builder in defer_hosts:
        raise ValueError(f"{builder} builds the Linux artifact and cannot be deferred")
    if "ax102" in defer_hosts and "ax42" not in defer_hosts:
        raise ValueError("ax42's off-box backup lives on ax102; defer ax42 too, or don't defer ax102.")
    installs = tuple(f"I{suffix}" for suffix in TARGET_SUFFIXES.values())
    coordinator = builder if "studio" in defer_hosts else "studio"
    nodes = (
        FastNode("Q", "readiness", coordinator, (), 30, ("release-coordinator",)),
        FastNode("A", "assemble", coordinator, ("Q",), 30, ("candidate-assembly",)),
        FastNode("M", "mac-cli", "studio", ("A",), 330, ("build-tree:mac-cli", "mac-signing")),
        FastNode("L", "linux-cli", builder, ("A",), 300, ("build-tree:linux-cli",)),
        FastNode("D", "desktop", "studio", ("M",), 330, ("build-tree:desktop", "mac-signing")),
        FastNode("SM", "prestage-mac", "studio", ("M",), 900, ("prestage:mac",), writes=(builder,)),
        FastNode("SL", "prestage-linux", "studio", ("L",), 900, ("prestage:linux",)),
        FastNode("SD", "prestage-desktop", "studio", ("D",), 900, ("prestage:desktop",), writes=(builder,)),
        *(node for host in LINUX_TARGETS for node in linux_nodes(host, builder, defer_hosts, defer_reason)),
        FastNode("IM", "install-studio", "studio", ("M",), 180, ("live-install:studio",), outcomes=INSTALL_OUTCOMES),
        FastNode("S", "desktop-swap", "studio", ("D", "IM"), 5, ("desktop-app:studio",)),
        FastNode("F", "publish-feed", "studio", ("S", *installs[1:], "SM", "SL", "SD"), 15, ("feed",)),
        FastNode("LM", "link-mesh", "studio", installs, 60, ("link-mesh",), gating=False),
        FastNode("LR", "land-receipts", "studio", (*installs, "F"), 60, (), gating=False),
        FastNode("H", "health-watch", "studio", ("F",), 600, (), gating=False),
        FastNode("AS", "advisory-suites", "studio", ("F",), 3600, (), gating=False),
        FastNode("W", "desktop-windows", "studio", ("SL", *(f"T{TARGET_SUFFIXES[host]}" for host in LINUX_TARGETS if host != builder and host not in defer_hosts)), 1500, ("build-host:pc",), gating=False),
        FastNode("FW", "publish-windows", "studio", ("F", "W"), 30, ("feed",), gating=False),
    )
    if "studio" not in defer_hosts:
        return nodes
    return tuple(replace(node, needs=(), budget=0, resources=(), writes=(), outcomes=("deferred",), defer_reason=defer_reason)
                 if node.host == "studio" else node for node in nodes)


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
