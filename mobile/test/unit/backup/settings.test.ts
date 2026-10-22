import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsChannel, parseSettings } from "../../../src/backup/settings.js";
import type { NativeToWeb } from "../../../src/bridge/protocol.js";

describe("parseSettings", () => {
  it("accepts an object of f2m_ keys with string values", () => {
    expect(parseSettings('{"f2m_units":"metric","f2m_style":"{}"}')).toEqual({
      f2m_units: "metric",
      f2m_style: "{}",
    });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["a key outside f2m_", '{"other":"x"}'],
    ["a non-string value", '{"f2m_units":3}'],
    ["a key that is only the prefix", '{"f2m_":"x"}'],
    ["more than the size cap", JSON.stringify({ f2m_a: "x".repeat(20_000) })],
  ])("refuses %s", (_name, json) => {
    expect(parseSettings(json)).toBeNull();
  });
});

describe("settings channel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const sent: NativeToWeb[] = [];
    const channel = createSettingsChannel({ send: (m) => sent.push(m), timeoutMs: 1000 });
    return { sent, channel };
  }

  it("asks the page and resolves with what it answers", async () => {
    const { sent, channel } = setup();
    const p = channel.request();
    expect(sent).toEqual([{ v: 1, type: "needSettings" }]);
    channel.onSettings('{"f2m_units":"imperial"}');
    expect(await p).toBe('{"f2m_units":"imperial"}');
  });

  it("rejects when the page stays silent", async () => {
    const { channel } = setup();
    const p = channel.request();
    const seen = expect(p).rejects.toThrow("page settings");
    await vi.advanceTimersByTimeAsync(1001);
    await seen;
  });

  it("rejects an answer that is not valid settings", async () => {
    const { channel } = setup();
    const p = channel.request();
    channel.onSettings('{"evil":"x"}');
    await expect(p).rejects.toThrow("page settings");
  });

  it("ignores an unrequested answer", () => {
    const { channel } = setup();
    expect(() => channel.onSettings("{}")).not.toThrow();
  });

  it("sends applySettings and resolves when the page confirms", async () => {
    const { sent, channel } = setup();
    const p = channel.apply('{"f2m_units":"metric"}');
    expect(sent).toEqual([{ v: 1, type: "applySettings", json: '{"f2m_units":"metric"}' }]);
    channel.onApplied();
    await p;
  });

  it("rejects an apply the page never confirms", async () => {
    const { channel } = setup();
    const p = channel.apply("{}");
    const seen = expect(p).rejects.toThrow("page settings");
    await vi.advanceTimersByTimeAsync(1001);
    await seen;
  });
});
