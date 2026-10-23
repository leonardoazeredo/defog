import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "../../../src/bridge/protocol.js";
import { createSend } from "../../../src/bridge/send.js";

describe("createSend", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("posts the encoded message at once, before any timer runs", () => {
    const post = vi.fn();
    const send = createSend({ post, schedule: (fn) => setTimeout(fn, 0) });

    send({ v: 1, type: "none" });

    expect(post).toHaveBeenCalledExactlyOnceWith(encode({ v: 1, type: "none" }));
    expect(vi.getTimerCount()).toBe(1);
  });

  it("schedules a turn of the event loop after each message, after its post", () => {
    const calls: string[] = [];
    const send = createSend({
      post: (raw) => calls.push(raw),
      schedule: () => calls.push("schedule"),
    });

    send({ v: 1, type: "back" });
    send({ v: 1, type: "needSettings" });

    expect(calls).toEqual([
      encode({ v: 1, type: "back" }),
      "schedule",
      encode({ v: 1, type: "needSettings" }),
      "schedule",
    ]);
  });

  it("keeps the order of messages", () => {
    const posted: string[] = [];
    const send = createSend({
      post: (raw) => posted.push(raw),
      schedule: (fn) => setTimeout(fn, 0),
    });

    send({ v: 1, type: "back" });
    send({ v: 1, type: "none" });
    vi.runAllTimers();

    expect(posted).toEqual([encode({ v: 1, type: "back" }), encode({ v: 1, type: "none" })]);
  });

  it("still schedules the turn when the page is not loaded", () => {
    const schedule = vi.fn();
    const send = createSend({ post: () => undefined, schedule });

    send({ v: 1, type: "none" });

    expect(schedule).toHaveBeenCalledOnce();
  });
});
