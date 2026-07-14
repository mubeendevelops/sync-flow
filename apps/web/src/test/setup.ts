import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// This repo imports test globals explicitly rather than enabling vitest's `globals: true`, so
// RTL's usual auto-cleanup (which detects a *global* afterEach) never registers on its own.
afterEach(() => {
  cleanup();
});
