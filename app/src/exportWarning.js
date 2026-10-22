// The warning that comes before every plaintext export: a card in the page with Continue and Cancel.
(function (global) {
  const TEXT = {
    fog: "This file is unencrypted and shows the places you have been. Anyone who gets it can read them.",
    gpx: "This file is unencrypted and shows the route you planned, point by point.",
    kml: "This file is unencrypted and shows the route you planned, point by point.",
    maps: "Google Maps will receive the start, the end and the stops of this route.",
  };

  function install({ doc }) {
    const card = doc.getElementById("exportWarning");
    const text = doc.getElementById("exportWarningText");
    const proceed = doc.getElementById("exportContinue");
    const cancel = doc.getElementById("exportCancel");
    let pending = null;

    function settle(ok) {
      if (!pending) return;
      const resolve = pending;
      pending = null;
      card.hidden = true;
      resolve(ok);
    }

    // A second request replaces the first, which counts as cancelled. The card is inserted after `anchor`
    // (a DOM element) when given, because the exports live in different tabs.
    function ask(kind, anchor) {
      if (!Object.prototype.hasOwnProperty.call(TEXT, kind)) return Promise.resolve(false);
      settle(false);
      text.textContent = TEXT[kind];
      if (anchor && anchor.after) anchor.after(card);
      card.hidden = false;
      // The safe answer takes the focus.
      if (cancel.focus) cancel.focus();
      return new Promise((resolve) => { pending = resolve; });
    }

    // The handler to put on a button: it shows the warning, after `anchor` when given, and runs `action` only after Continue.
    function guard(kind, action, anchor) {
      return () => ask(kind, anchor).then((ok) => { if (ok) action(); });
    }

    proceed.addEventListener("click", () => settle(true));
    cancel.addEventListener("click", () => settle(false));
    doc.addEventListener("keydown", (e) => { if (e.key === "Escape") settle(false); });

    return { ask, guard };
  }

  global.ExportWarning = { TEXT, install };
})(window);
