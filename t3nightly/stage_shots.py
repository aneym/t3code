import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import expect, sync_playwright

SHELVES = ["working", "snoozed", "settled", "automations"]


def sidebar(page):
    return page.locator('[data-sidebar="sidebar"]').first


def expand_shelves(page, notes):
    for shelf in SHELVES:
        toggle = page.get_by_test_id(f"sidebar-{shelf}-shelf-toggle")
        if toggle.count() == 0:
            toggle = page.get_by_role(
                "button", name=re.compile(f"^{shelf.title()}(?:\\s|$)")
            )
        if toggle.count() == 0:
            notes.append(f"no {shelf} shelf")
            continue
        if toggle.first.get_attribute("aria-expanded") != "true":
            toggle.first.click()
            page.wait_for_timeout(300)


def scroll_sidebar(page, to_bottom):
    page.evaluate(
        """(bottom) => {
          for (const el of document.querySelectorAll('[data-sidebar="sidebar"] *')) {
            if (el.scrollHeight > el.clientHeight + 4 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)) {
              el.scrollTop = bottom ? el.scrollHeight : 0;
            }
          }
        }""",
        to_bottom,
    )
    page.wait_for_timeout(300)


def capture(page, out, name):
    page.screenshot(path=str(out / f"{name}.png"))


def place_owners(page, owners, out):
    placements = page.evaluate(
        """async (owners) => {
          const ticketResponse = await fetch('/api/auth/websocket-ticket/rpc', {method: 'POST'});
          if (!ticketResponse.ok) throw new Error(`sandbox ticket failed: ${ticketResponse.status}`);
          const {ticket} = await ticketResponse.json();
          const socketUrl = new URL(location.origin.replace(/^http/, 'ws') + '/ws');
          socketUrl.searchParams.set('wsTicket', ticket);
          socketUrl.searchParams.set('orchestrationProtocol', '2');
          const socket = new WebSocket(socketUrl);
          const pending = new Map();
          socket.onmessage = ({data}) => {
            const decoded = JSON.parse(data);
            for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
              if (message._tag === 'Ping') socket.send(JSON.stringify({_tag: 'Pong'}));
              if (message._tag !== 'Exit') continue;
              const request = pending.get(message.requestId);
              if (!request) continue;
              pending.delete(message.requestId);
              clearTimeout(request.timer);
              if (message.exit._tag === 'Success') request.resolve(message.exit.value);
              else request.reject(new Error(JSON.stringify(message.exit)));
            }
          };
          await new Promise((resolve, reject) => {
            socket.onopen = resolve;
            socket.onerror = () => reject(new Error('sandbox placement socket failed'));
          });
          const dispatch = (command) => new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error('sandbox placement command timed out'));
            }, 60000);
            pending.set(id, {resolve, reject, timer});
            socket.send(JSON.stringify({_tag: 'Request', id,
              tag: 'orchestration.dispatchCommand', headers: [], payload: command}));
          });
          try {
            for (const threadId of owners) {
              await dispatch({type: 'thread.unpin', commandId: crypto.randomUUID(), threadId});
              await dispatch({type: 'thread.metadata.update', commandId: crypto.randomUUID(),
                threadId, automationTaskId: `automation:thread:${threadId}`});
            }
            const response = await fetch('/api/orchestration/shell', {
              headers: {'x-t3-orchestration-protocol': '2'}
            });
            if (!response.ok) throw new Error(`sandbox shell failed: ${response.status}`);
            const snapshot = await response.json();
            return owners.map(id => {
              const thread = snapshot.threads.find(thread => thread.id === id);
              if (!thread) throw new Error(`sandbox owner missing: ${id}`);
              const {automationTaskId, automationPlacementAt, latestUserAuthoredMessageAt,
                pinnedAt} = thread;
              if (pinnedAt != null || !automationTaskId ||
                  ('automationPlacementAt' in thread && (!automationPlacementAt ||
                   (latestUserAuthoredMessageAt != null &&
                    Date.parse(latestUserAuthoredMessageAt) > Date.parse(automationPlacementAt))))) {
                throw new Error(`sandbox owner placement failed: ${id}`);
              }
              return {id, automationTaskId, automationPlacementAt,
                latestUserAuthoredMessageAt, pinnedAt};
            });
          } finally {
            socket.close();
          }
        }""",
        owners,
    )
    (out / "owner-placement.json").write_text(json.dumps(placements, indent=2) + "\n")


def session(page, args, out, scheme, width, height, notes):
    tag = f"{scheme}-{width}"
    page.set_viewport_size({"width": width, "height": height})
    page.emulate_media(color_scheme=scheme)
    page.goto(f"{args.origin}/")
    if width < 768:
        trigger = page.locator('[data-sidebar="trigger"]').first
        trigger.wait_for(state="visible", timeout=60_000)
        trigger.click()
    sidebar(page).wait_for(state="visible", timeout=60_000)
    if args.owners:
        toggle = page.get_by_test_id("sidebar-automations-shelf-toggle")
        toggle.wait_for(state="visible", timeout=60_000)
        if toggle.get_attribute("aria-expanded") != "true":
            toggle.click()
        jobs = page.get_by_role("list", name="Automation jobs")
        for owner in args.owners:
            expect(jobs.locator(f'a[href*="{quote(owner, safe="")}"]')).to_have_count(1, timeout=60_000)
        toggle.click()
        expect(jobs).to_have_count(0)
    capture(page, out, f"{tag}-01-sidebar-top")
    badge = page.get_by_label("Fork build", exact=False)
    if badge.count():
        badge.first.hover()
        page.wait_for_timeout(800)
        capture(page, out, f"{tag}-02-badge-hover")
    else:
        notes.append(f"{tag}: no fork build badge")
    page.mouse.move(width - 20, height // 2)
    scroll_sidebar(page, True)
    capture(page, out, f"{tag}-03-sidebar-bottom-collapsed")
    expand_shelves(page, notes)
    scroll_sidebar(page, True)
    automations = page.get_by_role("list", name="Automation jobs")
    if args.owners:
        for owner in args.owners:
            expect(automations.locator(f'a[href*="{quote(owner, safe="")}"]')).to_have_count(1, timeout=60_000)
    if automations.count():
        automations.scroll_into_view_if_needed()
    capture(page, out, f"{tag}-04-sidebar-bottom-expanded")
    if width >= 768:
        for route in ["general", "appearance", "scheduled-tasks"]:
            page.goto(f"{args.origin}/settings/{route}")
            ready = {"general": "Thread notifications", "appearance": "Color scheme", "scheduled-tasks": "Applying settings for"}[route]
            page.get_by_text(ready, exact=False).first.wait_for(state="visible", timeout=60_000)
            capture(page, out, f"{tag}-05-settings-{route}")
            for step, fraction in enumerate([0.5, 1.0], start=1):
                page.evaluate(
                    """(fraction) => {
                      for (const el of document.querySelectorAll('main *, [role="dialog"] *')) {
                        if (el.scrollHeight > el.clientHeight + 4 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)) {
                          el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction;
                        }
                      }
                    }""",
                    fraction,
                )
                page.wait_for_timeout(300)
                capture(page, out, f"{tag}-05-settings-{route}-scroll{step}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", required=True)
    parser.add_argument("--pair", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--owners", default="[]")
    args = parser.parse_args()
    args.owners = json.loads(args.owners)
    out = Path(args.out)
    notes = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_context().new_page()
        page.goto(args.pair)
        page.wait_for_url(lambda url: "/pair" not in url, timeout=60_000)
        if args.owners:
            seed_page = page.context.new_page()
            try:
                seed_page.goto(f"{args.origin}/api/auth/session")
                place_owners(seed_page, args.owners, out)
            finally:
                seed_page.close()
        for scheme, width, height in [
            ("dark", 1440, 900),
            ("light", 1440, 900),
            ("dark", 390, 844),
        ]:
            session(page, args, out, scheme, width, height, notes)
        browser.close()
    (out / "notes.txt").write_text("\n".join(notes) + "\n")
    print("\n".join(notes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
