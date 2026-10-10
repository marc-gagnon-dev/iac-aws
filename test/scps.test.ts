import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { availableScps, MAX_SCP_CHARS, renderScp, SCP_DIR } from "../src/scps";

const vars = { allowedRegions: ["us-east-1", "us-west-2", "ca-central-1", "eu-west-1"] };

describe("SCP library", () => {
  for (const name of availableScps()) {
    it(`${name} renders to a valid, minified policy under the size limit`, () => {
      const rendered = renderScp(name, fs.readFileSync(path.join(SCP_DIR, `${name}.json`), "utf8"), vars);
      const doc = JSON.parse(rendered);
      expect(doc.Version).toBe("2012-10-17");
      expect(rendered).not.toMatch(/\{\{/);
      expect(rendered.length).toBeLessThanOrEqual(MAX_SCP_CHARS);
    });
  }
});

describe("renderScp", () => {
  it("substitutes whole-string variables with their JSON value", () => {
    const out = renderScp("t", '{"a": {"b": "{{allowedRegions}}"}, "c": "keep {{x}}"}', vars);
    expect(JSON.parse(out)).toEqual({ a: { b: vars.allowedRegions }, c: "keep {{x}}" });
  });

  it("rejects unknown variables", () => {
    expect(() => renderScp("t", '{"a": "{{nope}}"}', vars)).toThrow("unknown template variable {{nope}}");
  });

  it("rejects documents over the size limit", () => {
    const big = JSON.stringify({ a: "x".repeat(MAX_SCP_CHARS) });
    expect(() => renderScp("big", big, vars)).toThrow("AWS allows 5120");
  });
});
