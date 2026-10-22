// The Backup and Restore buttons of the Show your fog tab. Only the phone app can back up, and its adapter
// installs window.crossfog after this file has run, so the row appears once the page has loaded.
(function (global) {
  function install({ doc, win }) {
    const row = doc.getElementById("backupRow");
    const phone = () => win.crossfog || null;
    const refresh = () => { row.style.display = phone() ? "" : "none"; };
    doc.getElementById("backupBtn").addEventListener("click", () => { const p = phone(); if (p) p.backup(); });
    doc.getElementById("restoreBtn").addEventListener("click", () => { const p = phone(); if (p) p.restore(); });
    win.addEventListener("load", refresh);
    refresh();
    return { refresh };
  }

  global.BackupButtons = { install };
})(window);
