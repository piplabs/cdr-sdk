import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/logger.js";

describe("logger", () => {
  describe("errorMessage", () => {
    it("always returns a string for non-Error values", () => {
      expect(errorMessage(undefined)).toBe("undefined");
      expect(errorMessage({ code: "NOPE" })).toBe('{"code":"NOPE"}');
    });
  });
});
