const SYSTEMD_UNIT = "t3code.service";
const LAUNCHD_LABEL = "com.t3tools.t3code.service";
const SERVICE_WAIT_SECONDS = 60;

export const REMOTE_HOME_SERVER_SCRIPT = `resolve_default_runtime_port() {
  if [ "$T3_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"
    return
  fi
  node - "$DEFAULT_RUNTIME_FILE" <<'NODE'
const fs = require("node:fs");
const runtimePath = process.argv[2] ?? "";
try {
	  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
	  const pid = Number(runtime.pid);
	  const port = Number(runtime.port);
	  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {
	    process.exit(1);
	  }
  const origin = new URL(String(runtime.origin ?? ""));
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    process.exit(1);
  }
  process.kill(pid, 0);
  process.stdout.write(\`\${pid} \${port}\`);
} catch {
  process.exit(1);
}
NODE
}
user_systemctl() {
  XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user "$@" 2>/dev/null || true
}
canonical_dir() {
  [ -z "$1" ] || (cd "$1" 2>/dev/null && pwd -P) || true
}
service_home() {
  if [ "$(uname -s)" = "Darwin" ]; then
    sed -n -E '/<key>T3CODE_HOME<.key>/{n;s|^[[:space:]]*<string>(.*)</string>[[:space:]]*$|\\1|p;q;}' "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist" 2>/dev/null |
      sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\\&/g'
    return 0
  fi
  sed -n 's/^Environment=T3CODE_HOME=//p' "$HOME/.config/systemd/user/${SYSTEMD_UNIT}" 2>/dev/null | head -n 1 |
    sed -E -e 's/[[:space:]]+$//' -e '/^".*"$/{s/^"//;s/"$//;s/[\\](["\\])/\\1/g;}' -e 's/%%/%/g'
}
service_state() {
  if [ "$(uname -s)" = "Darwin" ]; then
    SERVICE_PRINT=0
    launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1 || SERVICE_PRINT=$?
    case "$SERVICE_PRINT" in
      0) printf 'up' ;;
      112) ;;
      113)
        SERVICE_DISABLED="$(launchctl print-disabled "gui/$(id -u)" 2>/dev/null)" || {
          printf 'unknown'
          return 0
        }
        case "$SERVICE_DISABLED" in
          *'"${LAUNCHD_LABEL}" => disabled'* | *'"${LAUNCHD_LABEL}" => true'*) ;;
          *) printf 'not loaded' ;;
        esac
        ;;
      *) printf 'unknown' ;;
    esac
    return 0
  fi
  SERVICE_ACTIVE="$(user_systemctl is-active ${SYSTEMD_UNIT})"
  case "$SERVICE_ACTIVE" in
    active | activating | deactivating | reloading | refreshing) printf 'up' ;;
    inactive | failed)
      case "$(user_systemctl is-enabled ${SYSTEMD_UNIT})" in
        enabled | enabled-runtime) printf '%s' "$SERVICE_ACTIVE" ;;
        '') printf 'unknown' ;;
      esac
      ;;
    *) printf 'unknown' ;;
  esac
}
adopt_service_server() {
  SERVICE_HOME="$(canonical_dir "$(service_home)")"
  if [ -z "$SERVICE_HOME" ] || [ "$SERVICE_HOME" != "$(canonical_dir "$DEFAULT_SERVER_HOME")" ]; then
    return 0
  fi
  SERVICE_DEADLINE=$(($(date +%s) + ${SERVICE_WAIT_SECONDS}))
  while SERVICE_STATE="$(service_state)" && { [ "$SERVICE_STATE" = "up" ] || [ "$SERVICE_STATE" = "unknown" ]; }; do
    SERVICE_RUNTIME="$(resolve_default_runtime_port 2>/dev/null || true)"
    REMOTE_PORT="\${SERVICE_RUNTIME#* }"
    if [ -n "$SERVICE_RUNTIME" ] && wait_ready 1000; then
      REMOTE_PID=""
      REMOTE_MANAGED="external"
      rm -f "$PID_FILE"
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
      return 0
    fi
    if [ "$(date +%s)" -ge "$SERVICE_DEADLINE" ]; then
      if [ "$SERVICE_STATE" = "unknown" ]; then
        printf 'T3 Code has a background service installed on this host, but its state could not be read. Run \`t3 service status\` on this host, then reconnect.\\n' >&2
      else
        printf 'The T3 Code background service on this host did not start serving within ${SERVICE_WAIT_SECONDS} seconds. Run \`t3 service restart\` on this host, then reconnect.\\n' >&2
      fi
      exit 1
    fi
    sleep 1
  done
  REMOTE_PORT=""
  if [ -n "$SERVICE_STATE" ]; then
    SERVICE_FIX='\`t3 service restart\`'
    if [ "$SERVICE_STATE" = "failed" ]; then
      SERVICE_FIX='\`systemctl --user reset-failed ${SYSTEMD_UNIT}\`, then \`t3 service restart\`'
    fi
    printf 'T3 Code runs as a background service on this host, but the service is not running (%s). Run %s on this host, then reconnect.\\n' "$SERVICE_STATE" "$SERVICE_FIX" >&2
    exit 1
  fi
}`;
