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
