/**
 * Register the picker service worker. The worker is hosted at
 * `<base>/picking/sw.js` and scoped to `<base>/picking/` so it only intercepts
 * the PWA — never the rest of the Forge ERP app.
 */
const basePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

let registered = false;

export function registerPickerServiceWorker(): void {
  if (registered) return;
  registered = true;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (typeof window === "undefined") return;
  // Skip in dev unless explicitly enabled — Vite HMR doesn't play well with
  // a network-intercepting SW. Production builds always register.
  const isDev = import.meta.env.DEV;
  if (isDev && !import.meta.env.VITE_PICKER_SW_DEV) return;
  const swUrl = `${basePath}/picking/sw.js`;
  const scope = `${basePath}/picking/`;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(swUrl, { scope })
      .catch((err) => {
        // Don't crash the picker if the SW fails to register — we'll fall back
        // to plain (online-only) operation.
        console.warn("[picker] service worker registration failed", err);
      });
  });
}
