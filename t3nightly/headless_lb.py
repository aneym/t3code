import json
import os
import urllib.parse
import urllib.request
import warnings

DEFAULT_URL = "http://127.0.0.1:2455"


def health(opener, candidate):
    try:
        url = candidate.rstrip("/")
        with opener.open(f"{url}/health", timeout=2) as response:
            value = json.loads(response.read(16384))
            if response.status != 200 or not isinstance(value, dict) or value.get("status") != "ok":
                return False
        with opener.open(f"{url}/openapi.json", timeout=2) as response:
            value = json.loads(response.read(2 * 1024 * 1024))
            info = value.get("info") if isinstance(value, dict) else None
            return response.status == 200 and isinstance(info, dict) and info.get("title") == "agent-lb"
    except (OSError, ValueError):
        return False


def agent_lb_url():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    configured = os.environ.get("AGENT_LB_URL") or os.environ.get("CLAUDE_LB_BASE_URL")
    if configured:
        try:
            parsed = urllib.parse.urlsplit(configured)
            valid = parsed.scheme in ("http", "https") and parsed.hostname and not (parsed.username or parsed.password or parsed.query or parsed.fragment)
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("agent-lb URL override must be an HTTP(S) URL without credentials, query or fragment; remote hosts and path prefixes are supported")
        if health(opener, configured):
            return configured.rstrip("/")
        warnings.warn("agent-lb URL override is unhealthy or does not identify agent-lb; trying local ports", stacklevel=2)
    for candidate in (DEFAULT_URL, "http://127.0.0.1:2456"):
        if health(opener, candidate):
            return candidate
    return DEFAULT_URL
