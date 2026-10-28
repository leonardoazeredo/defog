import { afterEach, expect, it, vi } from "vitest";
import { openLink } from "../../../src/bridge/openLink.js";
import { COPY } from "../../../src/copy.js";

afterEach(() => vi.restoreAllMocks());

it("opens the url and says nothing when it works", async () => {
  const open = vi.fn(() => Promise.resolve());
  const notify = vi.fn();
  await openLink("https://example.org/a", open, notify);
  expect(open).toHaveBeenCalledWith("https://example.org/a");
  expect(notify).not.toHaveBeenCalled();
});

it("tells the user and logs only the error class when no app can open the url", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const err = new Error("No Activity found to handle https://secret.example/?q=1");
  err.name = "ActivityNotFound";
  const notify = vi.fn();
  await openLink("https://secret.example/?q=1", () => Promise.reject(err), notify);
  expect(notify).toHaveBeenCalledWith(COPY.openLinkFailed);
  expect(JSON.stringify(warn.mock.calls)).toContain("ActivityNotFound");
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret.example");
  expect(COPY.openLinkFailed).not.toContain("secret");
});

it("handles a synchronous throw and a non-Error rejection", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const notify = vi.fn();
  await openLink(
    "https://x.example",
    () => {
      throw new TypeError("bad");
    },
    notify,
  );
  await openLink("https://x.example", () => Promise.reject("https://x.example"), notify);
  expect(notify).toHaveBeenCalledTimes(2);
});
