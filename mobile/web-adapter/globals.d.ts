export {};

interface Window {
  ReactNativeWebView?: { postMessage(data: string): void };
}

declare const __CROSSFOG_DEV_TOOLS__: boolean;
