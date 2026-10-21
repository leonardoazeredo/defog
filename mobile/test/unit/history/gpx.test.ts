import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { activityStats, GpxError, parseGpx } from "../../../src/history/gpx.js";

const fixture = readFileSync(new URL("../../fixtures/glancemap-walk.gpx", import.meta.url), "utf8");
const START = Date.parse("2026-03-01T10:00:00Z");

describe("parseGpx on a GlanceMap recording", () => {
  const parsed = parseGpx(fixture);

  it("reads every track point in file order, with the time in epoch milliseconds", () => {
    expect(parsed.points).toHaveLength(8);
    expect(parsed.points.map((p) => p.t)).toEqual([
      START,
      START + 3000,
      START + 6500,
      START + 9000,
      START + 12000,
      START + 60000,
      START + 63000,
      START + 66000,
    ]);
    expect(parsed.points[0]).toMatchObject({ lat: 51.4769, lon: 0.0005 });
  });

  it("uses the effective accuracy and falls back to the raw one", () => {
    expect(parsed.points[0]?.accuracy).toBe(6);
    expect(parsed.points[1]?.accuracy).toBe(7);
    expect(parsed.points[3]?.accuracy).toBeUndefined();
  });

  it("reads elevation, speed, heart rate, steps and cadence per point, and leaves the absent ones out", () => {
    expect(parsed.points[0]).toEqual({
      t: START,
      lat: 51.4769,
      lon: 0.0005,
      accuracy: 6,
      elevation: 45.2,
      speed: 1.2,
      heartRate: 96,
      steps: 0,
      cadence: 100,
    });
    expect(parsed.points[2]).toEqual({
      t: START + 6500,
      lat: 51.4771,
      lon: 0.0007,
      accuracy: 9,
    });
    expect(parsed.points[3]).toEqual({
      t: START + 9000,
      lat: 51.4772,
      lon: 0.0008,
      elevation: 45,
    });
  });

  it("takes the summary figures from the metadata, not from a point", () => {
    expect(parsed.summary).toEqual({
      steps: 47,
      calories: 14.2,
      heartRateAvg: 98,
      heartRateMax: 104,
      durationS: 33,
      distanceM: 71.5,
    });
  });

  it("spans the first to the last point", () => {
    expect(parsed.startedAt).toBe("2026-03-01T10:00:00.000Z");
    expect(parsed.endedAt).toBe("2026-03-01T10:01:06.000Z");
  });

  it("does not measure across the pause between two segments", () => {
    // Six steps of about 13.1 m; the 42 m jump across the pause would take it past 120.
    expect(parsed.trackDistanceM).toBeGreaterThan(78);
    expect(parsed.trackDistanceM).toBeLessThan(79.5);
  });
});

describe("parseGpx edge cases", () => {
  const wrap = (points: string, meta = "") =>
    `<gpx>${meta}<trk><trkseg>${points}</trkseg></trk></gpx>`;
  const pt = (extra = "", lat = "10", lon = "20") =>
    `<trkpt lat="${lat}" lon="${lon}">${extra}<time>2026-03-01T10:00:00Z</time></trkpt>`;

  it("throws GpxError for a file without track points", () => {
    expect(() => parseGpx("<gpx></gpx>")).toThrow(GpxError);
    expect(() => parseGpx("")).toThrow(GpxError);
  });

  it("throws GpxError for a point without a time", () => {
    expect(() => parseGpx(wrap('<trkpt lat="1" lon="2"></trkpt>'))).toThrow(GpxError);
  });

  it("throws GpxError for a position outside the globe", () => {
    expect(() => parseGpx(wrap(pt("", "91")))).toThrow(GpxError);
    expect(() => parseGpx(wrap(pt("", "10", "181")))).toThrow(GpxError);
    expect(() => parseGpx(wrap(pt("", "x")))).toThrow(GpxError);
  });

  it("keeps file content out of the error message", () => {
    const secret = "48.123456";
    try {
      parseGpx(wrap(`<trkpt lat="${secret}" lon="11.5"></trkpt>`));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it("reads a self-closing point as one that has no time", () => {
    expect(() => parseGpx(wrap('<trkpt lat="1" lon="2"/>'))).toThrow(GpxError);
  });

  it("has no summary when the file has no metadata extensions", () => {
    expect(parseGpx(wrap(pt())).summary).toBeUndefined();
  });

  it("accepts single-quoted attributes and extension prefixes it does not know by name", () => {
    const p = parseGpx(wrap(`<trkpt lat='10' lon='20'><time>2026-03-01T10:00:00Z</time></trkpt>`));
    expect(p.points[0]).toMatchObject({ lat: 10, lon: 20 });
  });
});

describe("activityStats", () => {
  it("prefers the watch's duration and distance and adds the pace", () => {
    expect(activityStats(parseGpx(fixture))).toEqual({
      durationS: 33,
      distanceM: 71.5,
      paceSPerKm: 33 / 0.0715,
      steps: 47,
      calories: 14.2,
      heartRateAvg: 98,
      heartRateMax: 104,
    });
  });

  it("measures duration and distance on the track when the summary lacks them", () => {
    const bare = fixture.replace(/<metadata>[\s\S]*<\/metadata>/, "");
    const stats = activityStats(parseGpx(bare));
    expect(stats.durationS).toBe(66);
    expect(stats.distanceM).toBeGreaterThan(78);
    expect(stats.distanceM).toBeLessThan(79.5);
    expect(stats.paceSPerKm).toBeCloseTo(66 / (stats.distanceM / 1000), 6);
    expect(stats).not.toHaveProperty("steps");
  });

  it("leaves the pace out for a track that did not move", () => {
    const stats = activityStats(
      parseGpx(
        `<gpx><trk><trkseg><trkpt lat="1" lon="2"><time>2026-03-01T10:00:00Z</time></trkpt></trkseg></trk></gpx>`,
      ),
    );
    expect(stats).toEqual({ durationS: 0, distanceM: 0 });
  });
});
