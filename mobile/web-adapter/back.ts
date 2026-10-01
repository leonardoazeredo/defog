export function handleBack(doc: Document): boolean {
  const sidebar = doc.getElementById("sidebar");
  if (sidebar == null || !sidebar.classList.contains("open")) return false;
  sidebar.classList.remove("open");
  return true;
}
