// The NextGIS Overpass key is from the build (app.config.ts extra), never from the page bundle:
// generated/web.ts is committed, and the key is to stay out of the repo. On Android this script,
// injected before content loads, can run after the page's own scripts, so overpass.js reads the key
// for each request and the event tells main.js to offer NextGIS in the endpoint choice it has
// already drawn. Without a key, pageConfigScript returns undefined and WebShell injects nothing. The trailing
// `true;` is there because react-native-webview wants an injected script to end on a truthy value.
export function pageConfigScript(key: unknown): string | undefined {
  if (typeof key !== "string" || !key) return undefined;
  return `window.crossfogNextgisKey = ${JSON.stringify(key)};window.dispatchEvent(new Event("crossfog-nextgis-key"));true;`;
}
