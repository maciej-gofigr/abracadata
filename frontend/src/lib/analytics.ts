// Google Analytics 4 (+ Google Ads conversions).
//
// Loaded from here rather than an inline <script> in index.html: the prod CSP
// deliberately omits 'unsafe-inline', so the standard gtag snippet would be
// blocked. This does the same work from a first-party module.
//
// Everything is config-driven — with no measurement ID configured (local dev,
// or a build without the arg) nothing loads and every call is a no-op, so the
// app never depends on analytics being present.

const GA_ID = (import.meta.env.VITE_GA_MEASUREMENT_ID ?? "").trim();
const ADS_ID = (import.meta.env.VITE_ADS_CONVERSION_ID ?? "").trim();
// Conversion labels, e.g. "AbC-D_efGhIjK". Empty = that conversion isn't sent.
const ADS_LABELS: Record<string, string> = {
  save_recipe: (import.meta.env.VITE_ADS_LABEL_SAVE_RECIPE ?? "").trim(),
  sign_up: (import.meta.env.VITE_ADS_LABEL_SIGN_UP ?? "").trim(),
};

type Params = Record<string, unknown>;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let ready = false;

export function initAnalytics(): void {
  if (ready || !GA_ID || typeof window === "undefined") return;
  ready = true;

  window.dataLayer = window.dataLayer || [];
  // Must be a plain function (not an arrow) that forwards `arguments`, exactly
  // as gtag.js expects.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag("js", new Date());
  // We send page_view manually so SPA route changes are counted correctly.
  window.gtag("config", GA_ID, { send_page_view: false });
  if (ADS_ID) window.gtag("config", ADS_ID);

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  document.head.appendChild(s);
}

/** Record an event. Safe to call when analytics is disabled. */
export function track(event: string, params: Params = {}): void {
  window.gtag?.("event", event, params);
}

/** A funnel step that is also a Google Ads conversion (for bidding/audiences). */
export function trackConversion(event: string, params: Params = {}): void {
  track(event, params);
  const label = ADS_LABELS[event];
  if (ADS_ID && label) {
    window.gtag?.("event", "conversion", { send_to: `${ADS_ID}/${label}` });
  }
}

/** Page view for the current URL — called on load and on SPA navigation. */
export function trackPageView(path: string, title?: string): void {
  track("page_view", {
    page_path: path,
    page_location: window.location.origin + path,
    ...(title ? { page_title: title } : {}),
  });
}

export const analyticsEnabled = (): boolean => Boolean(GA_ID);
