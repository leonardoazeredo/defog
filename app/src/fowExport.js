// The Fog of World export, page side: write the Sync tiles and hand them to the phone app in chunks.
// The phone app zips them under Sync/ and asks where to save, so nothing of the fog leaves the device here.
(function (global) {
  const CHUNK_BYTES = 1048576; // the bridge's limit per message, raw
  const SLICE_BYTES = 24576; // apply takes one argument per byte, so slice; a multiple of 3 so the pieces of base64 join

  function toBase64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += SLICE_BYTES) {
      out += global.btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE_BYTES)));
    }
    return out;
  }

  // One message per chunk; a file of no bytes is still one chunk.
  function chunksOf(files, exportId) {
    const out = [];
    for (const f of files) {
      const total = Math.max(1, Math.ceil(f.bytes.length / CHUNK_BYTES));
      for (let index = 0; index < total; index++) {
        const part = f.bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
        out.push({ exportId, name: f.name, index, total, files: files.length, data: toBase64(part) });
      }
    }
    return out;
  }

  const logFailure = (e) => console.warn("[export] Fog of World export failed", e && e.name); // the class only: no positions in a log

  // -> the number of files sent, 0 when there is no fog to export, null when no phone is attached or it could not be written.
  function run({ fogMap, phone, exportId }) {
    if (!phone) return null;
    try {
      const files = global.FogWriter.writeSync(fogMap);
      if (files.length === 0) return 0;
      for (const chunk of chunksOf(files, exportId)) phone.exportBinary(chunk);
      return files.length;
    } catch (e) {
      logFailure(e);
      return null;
    }
  }

  const STATUS_MS = 8000;
  // Longer than the phone app's EXPORT_IDLE_MS (60 s, mobile/src/flows/exportFlow.ts), so when some chunks are lost the app
  // normally reports the export failed before the page gives up (a slow bridge can reverse that, and then this
  // page's line shows); if none reach it, this limit is the only answer.
  const REPLY_MS = 90000;
  const ENDED = { saved: "Saved.", cancelled: "Not saved.", failed: "Couldn't save the export." };

  // The export button: one export at a time, held until the phone app answers with an exportStatus or REPLY_MS passes
  // (released at once when there is nothing to send or the writer failed; a `saving` status lifts the limit, since
  // the picker waits on the person).
  // `defer` runs the writer after "Preparing…" has painted, since writing the tiles holds the page for a while.
  function button({ button, status, canExport, newId, defer, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let pending = null;
    let replyTimer = null;
    let lineTimer = null;

    function refresh() {
      button.disabled = pending !== null || !canExport();
    }
    function say(text, expires) {
      status.textContent = text;
      clearTimer(lineTimer);
      lineTimer = expires ? setTimer(() => { status.textContent = ""; }, STATUS_MS) : null;
    }
    function end(text) {
      pending = null;
      clearTimer(replyTimer);
      replyTimer = null;
      refresh();
      say(text, true);
    }

    function start(send) {
      if (pending !== null || !canExport()) return;
      const id = newId();
      pending = id;
      refresh();
      say("Preparing…", false);
      defer(() => {
        let n;
        try {
          n = send(id);
        } catch (e) {
          logFailure(e);
          n = null;
        }
        if (n === null) return end("Couldn't write the export.");
        if (n === 0) return end("There is no fog to export yet.");
        say("Sending it to the app…", false);
        replyTimer = setTimer(() => end("The app did not answer. Try again."), REPLY_MS);
      });
    }

    function onStatus({ exportId, state }) {
      if (exportId !== pending) return;
      if (state === "saving") {
        // The picker waits on the person, for as long as they like.
        clearTimer(replyTimer);
        replyTimer = null;
        say("Choose where to save it…", false);
      } else if (ENDED[state]) {
        end(ENDED[state]);
      }
    }

    return { start, onStatus, refresh };
  }

  global.FowExport = { CHUNK_BYTES, STATUS_MS, REPLY_MS, toBase64, chunksOf, run, button };
})(window);
