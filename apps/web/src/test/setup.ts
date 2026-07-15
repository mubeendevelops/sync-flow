import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no ResizeObserver; cmdk (the slash-command menu list) touches it on mount.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom doesn't implement scrollIntoView; cmdk calls it when the highlighted item changes.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// This repo imports test globals explicitly rather than enabling vitest's `globals: true`, so
// RTL's usual auto-cleanup (which detects a *global* afterEach) never registers on its own.
afterEach(() => {
  cleanup();
});
