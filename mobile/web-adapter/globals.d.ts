export {};

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(data: string): void };
  }
  const __CROSSFOG_DEV_TOOLS__: boolean;
  const CACHE_ENABLED: boolean;
  const CRYPTO_SUBTLE: boolean;
}
