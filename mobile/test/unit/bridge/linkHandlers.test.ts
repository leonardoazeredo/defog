import { describe, expect, it, vi } from "vitest";
import { createLinkHandlers } from "../../../src/bridge/linkHandlers.js";
import { ORIGIN } from "../../../src/bridge/protocol.js";
import { COPY } from "../../../src/copy.js";

function setup(opts: { loaded?: boolean; fail?: boolean } = {}) {
  const open = vi.fn(async (_url: string) => {
    if (opts.fail) throw new TypeError("no app");
  });
  const notify = vi.fn();
  const handlers = createLinkHandlers({
    initialLoadDone: () => opts.loaded ?? true,
    open,
    notify,
  });
  return { open, notify, handlers };
}

describe("onShouldStartLoad", () => {
  it("opens a foreign link outside the app and stops the load", () => {
    const { open, handlers } = setup();
    expect(handlers.onShouldStartLoad({ url: "https://example.org/x" })).toBe(false);
    expect(open).toHaveBeenCalledExactlyOnceWith("https://example.org/x");
  });

  it("lets the first load of the origin through and opens nothing", () => {
    const { open, handlers } = setup({ loaded: false });
    expect(handlers.onShouldStartLoad({ url: ORIGIN })).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("blocks the origin after the first load without opening it", () => {
    const { open, handlers } = setup();
    expect(handlers.onShouldStartLoad({ url: `${ORIGIN}x` })).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("tells the user, without the URL, when opening fails", async () => {
    const { notify, handlers } = setup({ fail: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handlers.onShouldStartLoad({ url: "https://example.org/secret" });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledExactlyOnceWith(COPY.openLinkFailed));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("example.org");
    warn.mockRestore();
  });
});

describe("onOpenWindow", () => {
  it("opens a foreign target outside the app", () => {
    const { open, handlers } = setup();
    handlers.onOpenWindow({ nativeEvent: { targetUrl: "https://example.org/w" } });
    expect(open).toHaveBeenCalledExactlyOnceWith("https://example.org/w");
  });

  it.each([ORIGIN, "intent://x#Intent;end", "about:blank"])("does not open %s", (targetUrl) => {
    const { open, handlers } = setup();
    handlers.onOpenWindow({ nativeEvent: { targetUrl } });
    expect(open).not.toHaveBeenCalled();
  });

  it("tells the user when opening fails", async () => {
    const { notify, handlers } = setup({ fail: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handlers.onOpenWindow({ nativeEvent: { targetUrl: "https://example.org/w" } });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledExactlyOnceWith(COPY.openLinkFailed));
    warn.mockRestore();
  });
});
