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

  // -> the number of files sent, 0 when there is no fog to export, null when no phone is attached or it could not be written.
  function run({ fogMap, phone, newId }) {
    if (!phone) return null;
    try {
      const files = global.FogWriter.writeSync(fogMap);
      if (files.length === 0) return 0;
      for (const chunk of chunksOf(files, newId())) phone.exportBinary(chunk);
      return files.length;
    } catch (e) {
      console.warn("[export] Fog of World export failed", e && e.name); // the class only: no positions in a log
      return null;
    }
  }

  global.FowExport = { CHUNK_BYTES, toBase64, chunksOf, run };
})(window);
