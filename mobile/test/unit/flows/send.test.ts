import { describe, expect, it, vi } from "vitest";
import { encode, type NativeToWeb, parseNativeToWeb } from "../../../src/bridge/protocol.js";
import { COPY } from "../../../src/copy.js";
import { createSendFlow } from "../../../src/flows/send.js";
import { createMemoryRouteStore } from "../../../src/history/memoryStores.js";
import { createFakeWatchLink } from "../../../src/link/fakeWatchLink.js";
import { route } from "../history/fixtures.js";

function setup(listen = true) {
  const link = createFakeWatchLink();
  const routes = createMemoryRouteStore({ now: () => new Date("2026-03-01T09:30:00Z") });
  const sent: NativeToWeb[] = [];
  const flow = createSendFlow({ link, routes, send: (m) => sent.push(m) });
  const stop = listen ? flow.start() : () => undefined;
  return { link, routes, sent, flow, stop };
}

// What the page receives goes through the same schema; a slip here would drop the message there.
function valid(sent: NativeToWeb[]): void {
  for (const m of sent) expect(parseNativeToWeb(encode(m))).toEqual(m);
}

describe("send", () => {
  it("saves the route, queues it on the link and tells the page it is waiting", async () => {
    const { link, routes, sent, flow } = setup();
    const r = route();
    await flow.sendRoute(r);

    expect(await routes.get(r.id)).toMatchObject({ id: r.id });
    expect(link.queued()).toEqual([r]);
    expect(sent).toEqual([{ v: 1, type: "routeStatus", routeId: r.id, state: "waiting" }]);
    valid(sent);
  });

  it("marks the route sent and says it is on the watch once the watch confirms", async () => {
    const { link, routes, sent, flow } = setup();
    const r = route();
    await flow.sendRoute(r);
    sent.length = 0;

    link.confirmRoute(r.id);
    await vi_flush();

    expect((await routes.get(r.id))?.sentAt).toBe("2026-03-01T09:30:00.000Z");
    expect(sent).toEqual([{ v: 1, type: "routeStatus", routeId: r.id, state: "onWatch" }]);
    valid(sent);
  });

  it("does not mark the route sent before the watch confirms", async () => {
    const { routes, flow } = setup();
    const r = route();
    await flow.sendRoute(r);
    expect((await routes.get(r.id))?.sentAt).toBeUndefined();
  });

  it("reports a route it could not save as failed, without the route's content", async () => {
    const { link, sent } = setup();
    const broken = createSendFlow({
      link,
      routes: {
        ...createMemoryRouteStore(),
        save: async () => {
          throw new Error("disk full at 48.1,11.5");
        },
      },
      send: (m) => sent.push(m),
    });
    const r = route();
    await broken.sendRoute(r);

    expect(link.queued()).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "routeStatus",
      routeId: r.id,
      state: "failed",
      why: COPY.routeNotSent,
    });
    expect(JSON.stringify(sent)).not.toContain("48.1");
    valid(sent);
  });

  it("reports a route the link would not queue as failed", async () => {
    const { link, routes, sent } = setup();
    const flow = createSendFlow({
      link: {
        ...link,
        queueRoute: async () => {
          throw new Error("module unavailable");
        },
      },
      routes,
      send: (m) => sent.push(m),
    });
    const r = route();
    await flow.sendRoute(r);

    expect(sent).toEqual([
      expect.objectContaining({ type: "routeStatus", routeId: r.id, state: "failed" }),
    ]);
    valid(sent);
  });

  it("forwards link status changes to the page", async () => {
    const { link, sent } = setup();
    link.setStatus({ paired: true, reachable: true });
    expect(sent).toEqual([{ v: 1, type: "linkStatus", paired: true, reachable: true }]);
    valid(sent);
  });

  it("sends the current link status on request", async () => {
    const { link, sent, flow } = setup();
    await link.pair("payload");
    sent.length = 0;
    await flow.sendStatus();
    expect(sent).toEqual([{ v: 1, type: "linkStatus", paired: true, reachable: false }]);
  });

  it("still tells the page the watch has the route when marking it sent fails", async () => {
    const { link, sent } = setup(false);
    const flow = createSendFlow({
      link,
      routes: {
        ...createMemoryRouteStore(),
        markSent: async () => {
          throw new Error("unknown route");
        },
      },
      send: (m) => sent.push(m),
    });
    flow.start();
    const r = route();
    await flow.sendRoute(r);
    sent.length = 0;
    link.confirmRoute(r.id);
    await vi_flush();
    expect(sent).toEqual([{ v: 1, type: "routeStatus", routeId: r.id, state: "onWatch" }]);
  });

  it("sends nothing and does not reject when the link status cannot be read", async () => {
    const { link, sent } = setup(false);
    const flow = createSendFlow({
      link: {
        ...link,
        status: async () => {
          throw new Error("module unavailable");
        },
      },
      routes: createMemoryRouteStore(),
      send: (m) => sent.push(m),
    });
    await expect(flow.sendStatus()).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("tells the page a route the phone does not know is on the watch", async () => {
    const { link, routes, sent } = setup();
    await link.queueRoute(route());
    link.confirmRoute(route().id);
    await vi_flush();
    expect(sent).toEqual([{ v: 1, type: "routeStatus", routeId: route().id, state: "onWatch" }]);
    expect(await routes.get(route().id)).toBeNull();
  });

  it("keeps one record and one queued copy when a route that failed to queue is sent again", async () => {
    const { link, routes, sent } = setup(false);
    let refuse = true;
    const flow = createSendFlow({
      link: {
        ...link,
        queueRoute: async (r) => {
          if (refuse) throw new Error("module unavailable");
          await link.queueRoute(r);
        },
      },
      routes,
      send: (m) => sent.push(m),
    });
    const r = route();
    await flow.sendRoute(r);
    refuse = false;
    await flow.sendRoute(r);

    expect(await routes.list()).toHaveLength(1);
    expect(link.queued()).toEqual([r]);
    expect(sent.map((m) => m.type === "routeStatus" && m.state)).toEqual(["failed", "waiting"]);
  });

  it("logs only the error class of a failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { link, sent } = setup(false);
      const flow = createSendFlow({
        link,
        routes: {
          ...createMemoryRouteStore(),
          save: async () => {
            throw new Error("disk full at 48.1,11.5");
          },
        },
        send: (m) => sent.push(m),
      });
      await flow.sendRoute(route());
      expect(warn.mock.calls).toEqual([[expect.any(String), "Error"]]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("48.1");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not reject when the page cannot be told", async () => {
    const { link } = setup(false);
    const flow = createSendFlow({
      link,
      routes: createMemoryRouteStore(),
      send: () => {
        throw new Error("no web view");
      },
    });
    flow.start();
    await expect(flow.sendRoute(route())).resolves.toBeUndefined();
    await expect(flow.sendStatus()).resolves.toBeUndefined();
    expect(() => link.setStatus({ paired: true, reachable: true })).not.toThrow();
  });

  it("stops listening when the returned function is called", async () => {
    const { link, sent, flow, stop } = setup();
    await flow.sendRoute(route());
    sent.length = 0;
    stop();
    link.confirmRoute(route().id);
    link.setStatus({ paired: true, reachable: true });
    await vi_flush();
    expect(sent).toEqual([]);
  });
});

async function vi_flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
