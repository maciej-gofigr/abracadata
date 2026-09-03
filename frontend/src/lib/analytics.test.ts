import { describe, expect, it, beforeEach } from "vitest";
import { analyticsEnabled, initAnalytics, track, trackConversion, trackPageView } from "./analytics";

// No VITE_GA_MEASUREMENT_ID is set under test, so this exercises the
// unconfigured path — which must be completely inert rather than throwing or
// injecting anything into the page.
describe("analytics when no measurement ID is configured", () => {
  beforeEach(() => {
    delete (window as { gtag?: unknown }).gtag;
    delete (window as { dataLayer?: unknown }).dataLayer;
  });

  it("reports disabled and loads no script", () => {
    expect(analyticsEnabled()).toBe(false);
    initAnalytics();
    expect(document.querySelector('script[src*="googletagmanager"]')).toBeNull();
    expect(window.gtag).toBeUndefined();
  });

  it("event helpers are safe no-ops", () => {
    initAnalytics();
    expect(() => track("recipe_run", { table_count: 2 })).not.toThrow();
    expect(() => trackConversion("save_recipe", { kind: "first_save" })).not.toThrow();
    expect(() => trackPageView("/templates")).not.toThrow();
  });
});
