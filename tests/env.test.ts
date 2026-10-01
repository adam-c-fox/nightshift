import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";
import { authorizationHeader } from "../src/linear.js";

describe("parseEnv", () => {
  it("handles comments, quotes and export prefixes", () => {
    expect(parseEnv(["# c", "A=1", 'B="two words"', "export C='x'", "D=val # trailing", "", "bad line"].join("\n")))
      .toEqual({ A: "1", B: "two words", C: "x", D: "val" });
  });
});

describe("authorizationHeader", () => {
  it("sends personal keys raw and OAuth tokens as bearer", () => {
    expect(authorizationHeader("lin_api_abc")).toBe("lin_api_abc");
    expect(authorizationHeader("lin_oauth_abc")).toBe("Bearer lin_oauth_abc");
  });
});
