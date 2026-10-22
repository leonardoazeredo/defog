import { beforeEach, describe, expect, it } from "vitest";
import { createPageSettings } from "../../web-adapter/settings.js";

// jsdom gives this project's opaque origin no localStorage, so the tests bring a plain one.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  [name: string]: unknown;
}

let localStorage: Storage;
beforeEach(() => {
  localStorage = new MemoryStorage();
});

describe("page settings", () => {
  it("collects only the f2m_ keys", () => {
    localStorage.setItem("f2m_units", "imperial");
    localStorage.setItem("f2m_style", '{"a":1}');
    localStorage.setItem("other", "x");
    expect(JSON.parse(createPageSettings(localStorage).collect())).toEqual({
      f2m_units: "imperial",
      f2m_style: '{"a":1}',
    });
  });

  it("skips only the keys the phone would refuse", () => {
    localStorage.setItem("f2m_units", "metric");
    localStorage.setItem("f2m_bad-key", "x");
    localStorage.setItem(`f2m_${"k".repeat(70)}`, "x");
    expect(JSON.parse(createPageSettings(localStorage).collect())).toEqual({ f2m_units: "metric" });
  });

  it("keeps what fits when the settings are too large", () => {
    localStorage.setItem("f2m_a", "small");
    localStorage.setItem("f2m_b", "x".repeat(20_000));
    expect(JSON.parse(createPageSettings(localStorage).collect())).toEqual({ f2m_a: "small" });
  });

  it("collects an empty object when there are none", () => {
    expect(createPageSettings(localStorage).collect()).toBe("{}");
  });

  it("replaces the f2m_ keys and leaves the others", () => {
    localStorage.setItem("f2m_old", "gone");
    localStorage.setItem("other", "kept");
    expect(createPageSettings(localStorage).apply('{"f2m_units":"metric"}')).toBe(true);
    expect(localStorage.getItem("f2m_old")).toBeNull();
    expect(localStorage.getItem("f2m_units")).toBe("metric");
    expect(localStorage.getItem("other")).toBe("kept");
  });

  it("leaves the old settings in place when a write fails", () => {
    localStorage.setItem("f2m_old", "kept");
    const failing = new MemoryStorage();
    failing.setItem("f2m_old", "kept");
    failing.setItem = () => {
      throw new Error("quota");
    };
    expect(createPageSettings(failing).apply('{"f2m_new":"x"}')).toBe(false);
    expect(failing.getItem("f2m_old")).toBe("kept");
  });

  it("changes nothing when the settings are not valid", () => {
    localStorage.setItem("f2m_units", "metric");
    expect(createPageSettings(localStorage).apply('{"evil":"x"}')).toBe(false);
    expect(createPageSettings(localStorage).apply("not json")).toBe(false);
    expect(localStorage.getItem("f2m_units")).toBe("metric");
  });

  it("round-trips what it collected", () => {
    localStorage.setItem("f2m_loopkm", "12");
    const s = createPageSettings(localStorage);
    const json = s.collect();
    localStorage.clear();
    s.apply(json);
    expect(localStorage.getItem("f2m_loopkm")).toBe("12");
  });

  it("collects nothing when storage throws", () => {
    const broken = {
      get length(): number {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(createPageSettings(broken).collect()).toBe("{}");
  });
});
