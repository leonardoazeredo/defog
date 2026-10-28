import { beforeEach, describe, expect, it, vi } from "vitest";
import { route } from "../history/fixtures";

const native = {
  linkStatus: vi.fn(),
  pendingActivities: vi.fn(),
  unreadableActivities: vi.fn(),
  readActivity: vi.fn(),
  releaseActivity: vi.fn(),
  queueRoute: vi.fn(),
  onLinkEvent: vi.fn(),
};
vi.mock("../../../src/platform/watchLinkModule", () => native);

const { createNativeWatchLink, routeName } = await import("../../../src/link/watchLink");

const id = "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0001";
const routeId = "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0002";

beforeEach(() => {
  for (const fn of Object.values(native)) fn.mockReset();
});

describe("native watch link", () => {
  it("returns a valid status and rejects a malformed one", async () => {
    native.linkStatus.mockResolvedValue({ paired: false, reachable: false });
    await expect(createNativeWatchLink().status()).resolves.toEqual({
      paired: false,
      reachable: false,
    });
    native.linkStatus.mockResolvedValue({ paired: "no" });
    await expect(createNativeWatchLink().status()).rejects.toThrow();
  });

  it("lists pending activities and rejects an entry that is not an offer summary", async () => {
    const summary = { activityId: id, routeId, travelMode: "walk", encoderVersion: "1" };
    native.pendingActivities.mockResolvedValue([summary]);
    await expect(createNativeWatchLink().pendingActivities()).resolves.toEqual([summary]);
    native.pendingActivities.mockResolvedValue("nope");
    await expect(createNativeWatchLink().pendingActivities()).rejects.toThrow();
  });

  it("skips one malformed pending entry and still lists the others, warning without its content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = { activityId: id, travelMode: "walk", encoderVersion: "1" };
    native.pendingActivities.mockResolvedValue([{ ...good, activityId: "../secret" }, good]);
    await expect(createNativeWatchLink().pendingActivities()).resolves.toEqual([good]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    warn.mockRestore();
  });

  it("returns the count of unreadable staged items and rejects anything but a whole number", async () => {
    native.unreadableActivities.mockResolvedValue(2);
    await expect(createNativeWatchLink().unreadableActivities()).resolves.toBe(2);
    for (const bad of [-1, 1.5, "2"]) {
      native.unreadableActivities.mockResolvedValue(bad);
      await expect(createNativeWatchLink().unreadableActivities()).rejects.toThrow();
    }
  });

  it("reads an activity by parsing the offer JSON the native side returns", async () => {
    const offer = { activityId: id, travelMode: "walk", encoderVersion: "1", gpx: "<gpx/>" };
    native.readActivity.mockResolvedValue(JSON.stringify(offer));
    await expect(createNativeWatchLink().readActivity(id)).resolves.toEqual(offer);
    expect(native.readActivity).toHaveBeenCalledWith(id);
  });

  it("rejects an offer without a file, and text that is not JSON", async () => {
    native.readActivity.mockResolvedValue(
      JSON.stringify({ activityId: id, travelMode: "walk", encoderVersion: "1" }),
    );
    await expect(createNativeWatchLink().readActivity(id)).rejects.toThrow();
    native.readActivity.mockResolvedValue('{"gpx":"secret-track');
    const e = await createNativeWatchLink()
      .readActivity(id)
      .catch((x) => x);
    expect(e.message).toBe("watch link returned an unreadable activity");
    expect(e.cause).toBeUndefined();
  });

  it("passes the native failure for an unknown id through", async () => {
    const failure = Object.assign(new Error("none"), { code: "ERR_NOT_FOUND" });
    native.readActivity.mockRejectedValue(failure);
    await expect(createNativeWatchLink().readActivity(id)).rejects.toBe(failure);
  });

  it("releases by id", async () => {
    native.releaseActivity.mockResolvedValue(undefined);
    await createNativeWatchLink().release(id);
    expect(native.releaseActivity).toHaveBeenCalledWith(id);
  });

  it("queues a route as the routeOffer of the link contract", async () => {
    native.queueRoute.mockResolvedValue(undefined);
    const r = route({ createdAt: "2026-03-01T23:30:00Z", travelMode: "run", gpx: "<gpx>r</gpx>" });
    await createNativeWatchLink().queueRoute(r);
    const offer = JSON.parse(native.queueRoute.mock.calls[0]?.[0]);
    expect(offer).toEqual({
      routeId: r.id,
      name: expect.stringMatching(/^Route \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
      travelMode: "run",
      createdAt: "2026-03-01T23:30:00Z",
      gpx: "<gpx>r</gpx>",
    });
  });

  it.each([
    ["Asia/Tokyo", "2026-03-01T23:05:00Z", "Route 2026-03-02 08:05"],
    ["America/Los_Angeles", "2026-03-01T03:15:00Z", "Route 2026-02-28 19:15"],
  ])("names a route in local time (%s, %s)", (timeZone, createdAt, name) => {
    expect(routeName(route({ createdAt }), timeZone)).toBe(name);
  });

  it("refuses to pair before the transport exists", async () => {
    await expect(createNativeWatchLink().pair("qr")).rejects.toThrow("transport");
  });

  describe("events", () => {
    function listen(event: "activityStaged" | "linkStatus" | "routeSaved") {
      const remove = vi.fn();
      let deliver: (payload: unknown) => void = () => {};
      native.onLinkEvent.mockImplementation((_name: string, fn: (payload: unknown) => void) => {
        deliver = fn;
        return remove;
      });
      const seen = vi.fn();
      const off = createNativeWatchLink().on(event, seen);
      return { seen, off, remove, deliver: (payload: unknown) => deliver(payload) };
    }

    it.each([
      ["activityStaged", { activityId: id }],
      ["linkStatus", { paired: true, reachable: false }],
      ["routeSaved", { routeId }],
    ] as const)("delivers a valid %s payload", (event, payload) => {
      const l = listen(event);
      l.deliver(payload);
      expect(native.onLinkEvent).toHaveBeenCalledWith(event, expect.any(Function));
      expect(l.seen).toHaveBeenCalledExactlyOnceWith(payload);
    });

    it("drops a malformed payload with a warning that names none of it", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const l = listen("activityStaged");
      l.deliver({ activityId: "../secret" });
      expect(l.seen).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
      warn.mockRestore();
    });

    it("returns the native unsubscribe", () => {
      const l = listen("linkStatus");
      l.off();
      expect(l.remove).toHaveBeenCalledOnce();
    });
  });
});
