import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { parseNonNegInt } from "../src/utils.js";

/**
 * `parseNonNegInt` calls `process.exit(1)` via `errExit` on rejection. We
 * stub `process.exit` to throw a sentinel error so each rejection case can
 * be observed without actually terminating the test runner. `console.error`
 * is also stubbed to suppress the rejection diagnostic output that would
 * otherwise clutter test logs.
 */
class ProcessExitError extends Error {
  constructor(public readonly exitCode: number) {
    super(`process.exit(${exitCode})`);
  }
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new ProcessExitError(typeof code === "number" ? code : 1);
  });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("parseNonNegInt", () => {
  describe("accepts valid non-negative integer strings", () => {
    it("returns 0 for '0'", () => {
      expect(parseNonNegInt("0", "uuid", false)).toBe(0);
    });

    it("returns the integer for plain decimal digits", () => {
      expect(parseNonNegInt("42", "uuid", false)).toBe(42);
      expect(parseNonNegInt("12345", "uuid", false)).toBe(12345);
    });

    it("returns the maximum uint32 (10 digits)", () => {
      expect(parseNonNegInt("4294967295", "uuid", false)).toBe(4_294_967_295);
    });
  });

  describe("rejects strings that `parseInt` would silently coerce", () => {
    it("rejects digits with trailing garbage (the original #80 bug)", () => {
      // parseInt("12oops") === 12 in plain JavaScript — the old
      // CLI accepted this as uuid=12. parseNonNegInt must NOT.
      expect(() => parseNonNegInt("12oops", "uuid", false)).toThrow(ProcessExitError);
    });

    it("rejects floats", () => {
      expect(() => parseNonNegInt("123.45", "uuid", false)).toThrow(ProcessExitError);
      // Even an integer-valued float is rejected — strict input shape.
      expect(() => parseNonNegInt("123.0", "uuid", false)).toThrow(ProcessExitError);
    });

    it("rejects scientific notation", () => {
      expect(() => parseNonNegInt("1e5", "uuid", false)).toThrow(ProcessExitError);
    });

    it("rejects hex prefix", () => {
      expect(() => parseNonNegInt("0x10", "uuid", false)).toThrow(ProcessExitError);
    });

    it("rejects leading / trailing whitespace", () => {
      expect(() => parseNonNegInt(" 12", "uuid", false)).toThrow(ProcessExitError);
      expect(() => parseNonNegInt("12 ", "uuid", false)).toThrow(ProcessExitError);
      expect(() => parseNonNegInt("\t12", "uuid", false)).toThrow(ProcessExitError);
    });

    it("rejects sign prefix (positive or negative)", () => {
      expect(() => parseNonNegInt("+12", "uuid", false)).toThrow(ProcessExitError);
      expect(() => parseNonNegInt("-12", "uuid", false)).toThrow(ProcessExitError);
    });

    it("rejects empty string", () => {
      expect(() => parseNonNegInt("", "uuid", false)).toThrow(ProcessExitError);
    });

    it("rejects pure non-digit input", () => {
      expect(() => parseNonNegInt("abc", "timeout", false)).toThrow(ProcessExitError);
      // `parseInt` returns NaN here — the old CLI passed NaN as `timeoutMs`
      // straight into the SDK, surfacing as an immediate or infinite-loop
      // timeout downstream. The strict check rejects it at the CLI boundary.
    });
  });

  describe("rejects values exceeding safe-integer range", () => {
    it("rejects 21+ digit strings (parseInt loses precision)", () => {
      const huge = "9".repeat(21);
      // parseInt(huge, 10) === 1e21, which is not a safe integer.
      expect(() => parseNonNegInt(huge, "uuid", false)).toThrow(ProcessExitError);
    });
  });

  describe("error reporting", () => {
    it("calls console.error with the label and value when rejecting (non-JSON mode)", () => {
      try {
        parseNonNegInt("12oops", "uuid", /* json */ false);
      } catch {
        /* ProcessExitError */
      }
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid uuid: 12oops"),
      );
    });

    it("emits a structured JSON error when json=true", () => {
      try {
        parseNonNegInt("abc", "timeout", /* json */ true);
      } catch {
        /* ProcessExitError */
      }
      expect(errorSpy).toHaveBeenCalledOnce();
      const payload = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(payload).toEqual({
        error: {
          message: expect.stringContaining("Invalid timeout: abc"),
        },
      });
    });

    it("exits with code 1 on rejection", () => {
      try {
        parseNonNegInt("nope", "uuid", false);
      } catch (err) {
        expect(err).toBeInstanceOf(ProcessExitError);
        expect((err as ProcessExitError).exitCode).toBe(1);
      }
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
