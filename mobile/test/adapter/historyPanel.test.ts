import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ActivitySummary,
  encode,
  parseWebToNative,
  type WebToNative,
} from "../../src/bridge/protocol.js";
import { installPageApi } from "../../web-adapter/pageApi.js";
import { loadUpstreamDom } from "./support/upstreamDom.js";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../../../app");
const evalApp = (file: string) =>
  (window as unknown as { eval(code: string): void }).eval(readFileSync(`${APP}/${file}`, "utf-8"));

interface Layer {
  options: { pane?: string };
  getLatLngs?: unknown;
}
interface LeafletMap {
  setView(c: [number, number], z: number): void;
  getPane(name: string): HTMLElement | undefined;
  eachLayer(fn: (l: Layer) => void): void;
}
interface Route {
  setFixedRoute(pins: unknown[], coords: number[][], stats: object): number;
  _applyRoute(coords: number[][], stats: object): void;
  clear(): void;
  routeRecord(): { id: string; gpx: string } | null;
}
interface Panel {
  setActivities(items: ActivitySummary[]): void;
  setTrack(id: string, points: unknown[], route?: { coords: number[][] }): void;
  refresh(): void;
}
interface SendControl {
  update(): void;
  routeStatus(msg: { routeId: string; state: string }): void;
  linkStatus(msg: { paired: boolean; reachable: boolean }): void;
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const ROUTE = "44444444-4444-4444-8444-444444444444";

function summary(id: string, startedAt: string, over: Partial<ActivitySummary> = {}) {
  return {
    id,
    travelMode: "walk",
    startedAt,
    endedAt: startedAt,
    stats: { durationS: 3725, distanceM: 4321, steps: 5400 },
    ...over,
  } satisfies ActivitySummary;
}

let sent: WebToNative[];
let panel: Panel;
let send: SendControl;
let route: Route;
let map: LeafletMap;
let shown: ReturnType<typeof vi.fn>;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const cards = () => Array.from(document.querySelectorAll<HTMLElement>("#historyList .histCard"));
const click = (el: Element | null) => (el as HTMLElement).click();
const button = (text: string) =>
  Array.from($("historyDetail").querySelectorAll("button")).find((b) =>
    b.textContent?.startsWith(text),
  ) as HTMLButtonElement;
const routePaths = () => {
  let n = 0;
  map.eachLayer((l) => {
    // Leaflet also adds a renderer layer per pane; only lines count
    if (l.options?.pane === "routes" && l.getLatLngs) n++;
  });
  return n;
};

beforeEach(() => {
  loadUpstreamDom(document);
  sent = [];
  shown = vi.fn();
  evalApp("vendor/leaflet.js");
  evalApp("src/history.js");
  evalApp("src/route.js");
  const w = window as unknown as Record<string, any>;
  const holder = document.createElement("div");
  document.body.appendChild(holder);
  map = w.L.map(holder);
  map.setView([51, 13.7], 14);
  route = new w.RouteTool(map, { onChange: () => send.update() });
  installPageApi(window, (msg) => sent.push(msg as WebToNative));
  ({ panel, send } = w.HistoryPanel.install({
    doc: document,
    map,
    getUnits: () => "metric",
    getRecord: () => route.routeRecord(),
    phone: () => window.crossfog ?? null,
    onShown: shown,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("History tab", () => {
  it("shows the empty note until activities arrive", () => {
    panel.setActivities([]);
    expect($("historyEmpty").style.display).toBe("");
    panel.setActivities([summary(A, "2026-03-01T10:00:00Z")]);
    expect($("historyEmpty").style.display).toBe("none");
  });

  it("renders one card per activity, newest first", () => {
    panel.setActivities([
      summary(A, "2026-03-01T10:00:00Z"),
      summary(B, "2026-03-03T10:00:00Z"),
      summary(C, "2026-03-02T10:00:00Z"),
    ]);
    expect(cards().map((c) => c.dataset.id)).toEqual([B, C, A]);
    expect(cards()[0]?.textContent).toContain("4.3 km");
    expect(cards()[0]?.textContent).toContain("1 h 02 min");
    expect(cards()[0]?.textContent).toContain("5400 steps");
  });

  it("orders same-second activities by their fractions", () => {
    panel.setActivities([summary(A, "2026-03-01T10:00:00Z"), summary(B, "2026-03-01T10:00:00.5Z")]);
    expect(cards().map((c) => c.dataset.id)).toEqual([B, A]);
  });

  it("leaves out the steps line when the summary has no steps", () => {
    panel.setActivities([
      summary(A, "2026-03-01T10:00:00Z", { stats: { durationS: 600, distanceM: 900 } }),
    ]);
    expect(cards()[0]?.textContent).not.toContain("steps");
  });

  it("shows what the watch called the travel mode as text, never as markup", () => {
    panel.setActivities([
      summary(A, "2026-03-01T10:00:00Z", { travelMode: "<img src=x onerror=boom()>" }),
    ]);
    expect(document.querySelector("#historyList img")).toBeNull();
    expect(cards()[0]?.textContent).toContain("<img src=x");
  });

  it("asks for the track when a card is tapped and shows the detail", () => {
    panel.setActivities([summary(A, "2026-03-01T10:00:00Z")]);
    click(cards()[0] ?? null);
    expect(sent).toEqual([{ v: 1, type: "needTrack", activityId: A }]);
    expect($("historyDetail").style.display).toBe("");
    expect($("historyList").style.display).toBe("none");
    expect(button("Show on map").disabled).toBe(true);

    panel.setTrack(A, [
      { t: 0, lat: 51, lon: 13.7 },
      { t: 1, lat: 51.001, lon: 13.701 },
    ]);
    expect(button("Show on map").disabled).toBe(false);
  });

  it("ignores a track for an activity that is not open", () => {
    panel.setActivities([summary(A, "2026-03-01T10:00:00Z")]);
    click(cards()[0] ?? null);
    panel.setTrack(B, [{ t: 0, lat: 51, lon: 13.7 }]);
    expect(button("Show on map").disabled).toBe(true);
  });

  it("draws the track and the followed route in the routes pane, and takes them off again", () => {
    panel.setActivities([summary(A, "2026-03-01T10:00:00Z", { routeId: ROUTE })]);
    click(cards()[0] ?? null);
    panel.setTrack(
      A,
      [
        { t: 0, lat: 51, lon: 13.7 },
        { t: 1, lat: 51.001, lon: 13.701 },
      ],
      {
        coords: [
          [13.7, 51],
          [13.702, 51.001],
        ],
      },
    );
    click(button("Show on map"));
    expect(routePaths()).toBe(2);
    click(button("Hide from map"));
    expect(routePaths()).toBe(0);

    click(button("Show on map"));
    click(button("← All"));
    expect(routePaths()).toBe(0);
    expect($("historyList").style.display).toBe("");
  });

  it("tells the page once a track is on the map, so it can drop the sheet", () => {
    panel.setActivities([summary(A, "2026-03-01T10:00:00Z")]);
    click(cards()[0] ?? null);
    panel.setTrack(A, [
      { t: 0, lat: 51, lon: 13.7 },
      { t: 1, lat: 51.001, lon: 13.701 },
    ]);
    expect(shown).not.toHaveBeenCalled();
    click(button("Show on map"));
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it("draws only the track when the activity followed no route", () => {
    panel.setActivities([summary(A, "2026-03-01T10:00:00Z")]);
    click(cards()[0] ?? null);
    panel.setTrack(A, [
      { t: 0, lat: 51, lon: 13.7 },
      { t: 1, lat: 51.001, lon: 13.701 },
    ]);
    click(button("Show on map"));
    expect(routePaths()).toBe(1);
  });

  it("deletes on the second tap only, without a dialog", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alert = vi.spyOn(window, "alert").mockReturnValue(undefined);
    panel.setActivities([summary(A, "2026-03-01T10:00:00Z")]);
    click(cards()[0] ?? null);
    sent.length = 0;

    click(button("Delete"));
    expect(sent).toEqual([]);
    expect(button("Confirm").textContent).toBe("Confirm delete");

    click(button("Confirm"));
    expect(sent).toEqual([{ v: 1, type: "deleteActivity", activityId: A }]);
    expect($("historyList").style.display).toBe("");
    expect(confirm).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("does not delete on the first tap after the card re-renders while armed", () => {
    panel.setActivities([summary(A, "2026-03-01T10:00:00Z")]);
    click(cards()[0] ?? null);
    sent.length = 0;
    click(button("Delete"));
    // the track arriving rebuilds the buttons, which show Delete again
    panel.setTrack(A, [{ t: 0, lat: 51, lon: 13.7 }]);
    expect(button("Delete").textContent).toBe("Delete");
    click(button("Delete"));
    expect(sent).toEqual([]);
    expect(button("Confirm").textContent).toBe("Confirm delete");
  });

  it("disarms the delete after a pause", () => {
    vi.useFakeTimers();
    panel.setActivities([summary(A, "2026-03-01T10:00:00Z")]);
    click(cards()[0] ?? null);
    sent.length = 0;
    click(button("Delete"));
    vi.advanceTimersByTime(5000);
    expect(button("Delete").textContent).toBe("Delete");
    click(button("Delete"));
    expect(sent).toEqual([]);
  });

  it("closes the detail when its activity leaves the list", () => {
    panel.setActivities([summary(A, "2026-03-01T10:00:00Z"), summary(B, "2026-03-02T10:00:00Z")]);
    click(cards()[1] ?? null);
    panel.setActivities([summary(B, "2026-03-02T10:00:00Z")]);
    expect($("historyList").style.display).toBe("");
    expect(cards().map((c) => c.dataset.id)).toEqual([B]);
  });
});

const PINS = () => {
  const L = (window as unknown as { L: { latLng(a: number, b: number): unknown } }).L;
  return [L.latLng(51, 13.7), L.latLng(51, 13.71)];
};
const COORDS = [
  [13.7, 51, 120],
  [13.705, 51.001, 121],
  [13.71, 51, 119],
];
const STATS = { km: 0.7, seconds: 520, ascent: 3, descent: 4 };

describe("Send to watch", () => {
  const sendBtn = () => $("sendWatch") as HTMLButtonElement;
  const chip = () => $("sendStatus").textContent;

  it("is off until a route exists", () => {
    expect(sendBtn().disabled).toBe(true);
    route.setFixedRoute(PINS(), COORDS, STATS);
    send.update();
    expect(sendBtn().disabled).toBe(false);
    route.clear();
    send.update();
    expect(sendBtn().disabled).toBe(true);
  });

  it("posts a route record that native accepts, with the id in the GPX keywords", () => {
    route.setFixedRoute(PINS(), COORDS, STATS);
    send.update();
    click(sendBtn());

    expect(sent).toHaveLength(1);
    const msg = sent[0] as Extract<WebToNative, { type: "sendRoute" }>;
    expect(msg.type).toBe("sendRoute");
    expect(msg.route.gpx).toContain(`<keywords>crossfog-route:${msg.route.id}</keywords>`);
    expect(msg.route.id).toBe(route.routeRecord()?.id);
    expect(parseWebToNative(encode(msg))).toEqual(msg);
  });

  it("shows what the phone reports for the route it sent", () => {
    route.setFixedRoute(PINS(), COORDS, STATS);
    send.update();
    click(sendBtn());
    const id = (sent[0] as Extract<WebToNative, { type: "sendRoute" }>).route.id;
    expect(chip()).toBe("");

    send.routeStatus({ routeId: id, state: "waiting" });
    expect(chip()).toBe("Waiting for watch");
    send.routeStatus({ routeId: id, state: "onWatch" });
    expect(chip()).toBe("On the watch");
    send.routeStatus({ routeId: id, state: "failed" });
    expect(chip()).toBe("Could not send");
  });

  it("ignores a status for another route", () => {
    route.setFixedRoute(PINS(), COORDS, STATS);
    send.update();
    click(sendBtn());
    send.routeStatus({ routeId: ROUTE, state: "onWatch" });
    expect(chip()).toBe("");
  });

  it("says Not paired when the link is not, and Waiting for watch once a route is sent", () => {
    send.linkStatus({ paired: false, reachable: false });
    expect(chip()).toBe("Not paired");

    route.setFixedRoute(PINS(), COORDS, STATS);
    send.update();
    click(sendBtn());
    const id = (sent[0] as Extract<WebToNative, { type: "sendRoute" }>).route.id;
    send.routeStatus({ routeId: id, state: "waiting" });
    expect(chip()).toBe("Waiting for watch");

    send.linkStatus({ paired: true, reachable: false });
    expect(chip()).toBe("Waiting for watch");
  });

  it("blanks the status when the route is edited or cleared", () => {
    route.setFixedRoute(PINS(), COORDS, STATS);
    send.update();
    click(sendBtn());
    const id = (sent[0] as Extract<WebToNative, { type: "sendRoute" }>).route.id;
    send.routeStatus({ routeId: id, state: "onWatch" });

    route._applyRoute([...COORDS, [13.72, 51.001, 118]], { ...STATS, km: 0.9 });
    send.update();
    expect(chip()).toBe("");
    send.routeStatus({ routeId: id, state: "onWatch" });
    expect(chip()).toBe("");

    click(sendBtn());
    send.routeStatus({ routeId: id, state: "waiting" });
    expect(chip()).toBe("Waiting for watch");
    route.clear();
    send.update();
    expect(chip()).toBe("");
  });

  it("keeps the button off and does not throw when the record cannot be built", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    route.setFixedRoute(PINS(), COORDS, STATS);
    route.routeRecord = () => {
      throw new Error("no crypto");
    };
    expect(() => send.update()).not.toThrow();
    expect(sendBtn().disabled).toBe(true);
  });

  it("does nothing outside the phone app", () => {
    delete (window as { crossfog?: unknown }).crossfog;
    route.setFixedRoute(PINS(), COORDS, STATS);
    send.update();
    expect(sendBtn().disabled).toBe(true);
  });
});
