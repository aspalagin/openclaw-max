/**
 * Tests for MAX monitor (interface verification)
 */

import { describe, it, expect } from "vitest";
import { startMaxPolling } from "./monitor.js";

describe("MAX Monitor", () => {
  describe("startMaxPolling", () => {
    it("should be a function", () => {
      expect(typeof startMaxPolling).toBe("function");
    });

    it("should accept correct parameters", () => {
      // Interface test - verify function signature
      expect(startMaxPolling.length).toBe(1); // Single options object
    });
  });

  // Full integration tests for monitor would require:
  // - Mock PluginRuntime
  // - Mock MaxApi.getUpdates with long-polling simulation
  // - Mock inbound dispatch pipeline
  // These are better suited for E2E tests rather than unit tests.
});
