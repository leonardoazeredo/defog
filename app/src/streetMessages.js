// What the page says about a street download: its progress, and why a failed one failed. Built only from
// the error's reason, its cause's reason, tile counts and retry time, never a message: that can hold a
// server remark or a tile number, which locates the area.
(function (global) {
  const GENERIC = "Couldn't download the street map. Try again in a minute.";
  const BLOCKED_ADVICE = "Try another network, or try again tomorrow";

  // " in about 30 s" from retryAt, or null without a retry time or a clock. Rounded up to 10 s because
  // the text is read a while after it is set and an exact count would promise too early; a wait past
  // two minutes reads better in minutes.
  function wait(retryAt, now) {
    if (!retryAt || !Number.isFinite(now)) return null;
    const s = Math.max(10, Math.ceil((retryAt - now) / 10000) * 10);
    return s <= 120 ? ` in about ${s} s` : ` in about ${Math.ceil(s / 60)} min`;
  }

  // Why the run stopped short, from the first failure's reason.
  function stopped(cause) {
    const reason = cause && cause.reason;
    return reason === "stalled" ? "the server got too slow"
      : reason === "offline" ? "the connection dropped"
      : reason === "blocked" ? "the server blocked this network for today"
      : "the server stopped";
  }

  // err: a rejection from StreetIndex.ensureRects ({reason, done, total, retryAt, cause}), what
  // StreetIndex.downloadFacts keeps of one, or anything else thrown on the way; now: the clock retryAt is on.
  function describe(err, now) {
    const reason = err && err.reason, retryAt = err && err.retryAt;
    if (reason === "busy") return "The street servers are busy. Try again" + (wait(retryAt, now) || " in a minute") + ".";
    if (reason === "blocked") return "The street server has blocked this network for today: it caps each network's daily use. " + BLOCKED_ADVICE + ".";
    if (reason === "stalled") return "The street server is slow to answer. Try again" + (wait(retryAt, now) || " in a few minutes") + ".";
    if (reason === "offline") return "You're offline. This area's street map is downloaded once and kept on the phone.";
    if (reason === "streets-partial" && Number.isInteger(err.done) && Number.isInteger(err.total)) {
      const again = err.cause && err.cause.reason === "blocked" ? BLOCKED_ADVICE : "Try again" + (wait(retryAt, now) || "");
      return `Got ${err.done} of ${err.total} pieces of the street map before ${stopped(err.cause)}. ${again}: only the rest is downloaded.`;
    }
    return GENERIC;
  }

  function progress(done, total) {
    return Number.isInteger(done) && Number.isInteger(total)
      ? `Getting the street map, ${done} of ${total}…` : "Getting the street map…";
  }

  global.StreetMessages = { describe, progress };
})(window);
