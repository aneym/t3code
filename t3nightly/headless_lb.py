import os
import urllib.error
import urllib.parse
import urllib.request


def agent_lb_url():
    configured = os.environ.get("AGENT_LB_URL") or os.environ.get("CLAUDE_LB_BASE_URL")
    candidates = [configured] if configured else [f"http://127.0.0.1:{port}" for port in (2455, 2456)]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for candidate in candidates:
        parsed = urllib.parse.urlsplit(candidate)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("headless agent-lb URL must be a local HTTP origin")
        url = candidate.rstrip("/")
        try:
            with opener.open(f"{url}/health", timeout=2) as response:
                if response.status == 200:
                    return url
        except (OSError, urllib.error.URLError):
            continue
    raise RuntimeError("no healthy local agent-lb; set AGENT_LB_URL to its local HTTP origin")
