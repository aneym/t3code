import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { useComposerSendHold } from "./useComposerSendHold";
import type { OperateAccess } from "../../state/session";

function Composer(props: { readonly operate: OperateAccess; readonly send: () => void }) {
  const hold = useComposerSendHold({
    holdKey: "thread-1",
    thread: "thread-1",
    reason: null,
    providerPending: false,
    noProvider: false,
    operate: props.operate,
    prompt: "hello",
  });
  return (
    <>
      <ComposerBannerStack items={hold.banners} />
      <button type="button" onClick={() => hold.submit(props.send)}>
        Send
      </button>
    </>
  );
}

it("holds a send pressed before the chat can operate and sends it once when it can", async () => {
  const send = vi.fn();
  await using screen = await render(<Composer operate="pending" send={send} />);
  const button = screen.getByRole("button", { name: "Send" });
  await userEvent.click(button);
  await userEvent.click(button);

  await screen.rerender(<Composer operate="pending" send={send} />);
  await screen.rerender(<Composer operate="granted" send={send} />);
  await screen.rerender(<Composer operate="pending" send={send} />);
  await screen.rerender(<Composer operate="granted" send={send} />);

  expect(send).toHaveBeenCalledTimes(1);
  expect(screen.container.textContent).not.toContain("Not sent");
});
