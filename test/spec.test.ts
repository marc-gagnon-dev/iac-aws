import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { availableScps } from "../src/scps";
import { accountEmail, expandOuPaths, loadSpec, parseSpec } from "../src/spec";

const SCPS = ["deny-leave-org", "region-guard"];

function base(overrides: Record<string, unknown> = {}) {
  return {
    region: "us-east-1",
    accountEmail: "me+aws-{account}@example.com",
    selfRepo: "me/iac-aws",
    allowedRegions: ["us-east-1"],
    ous: ["Workloads/Prod"],
    accounts: { "app-prod": { ou: "Workloads/Prod" } },
    ...overrides,
  };
}

function problems(raw: unknown): string {
  try {
    parseSpec(raw, SCPS);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the spec to be rejected");
}

describe("spec files", () => {
  it("org.example.yaml is valid", () => {
    expect(() => loadSpec(path.join(__dirname, "..", "org.example.yaml"), availableScps())).not.toThrow();
  });

  // In a bootstrapped copy, CI fails here on a bad org.yaml before anything reaches AWS.
  const orgYaml = path.join(__dirname, "..", "org.yaml");
  it.runIf(fs.existsSync(orgYaml))("org.yaml is valid", () => {
    expect(() => loadSpec(orgYaml, availableScps())).not.toThrow();
  });
});

describe("parseSpec", () => {
  it("accepts a minimal spec and fills defaults", () => {
    const spec = parseSpec(base(), SCPS);
    expect(spec.scps).toEqual({});
    expect(spec.accounts["app-prod"]).toMatchObject({ closeOnDeletion: false, github: {} });
  });

  it("allows accounts in implied parent OUs", () => {
    expect(() => parseSpec(base({ accounts: { ops: { ou: "Workloads" } } }), SCPS)).not.toThrow();
  });

  it("rejects an account in an undeclared OU", () => {
    expect(problems(base({ accounts: { ops: { ou: "Nope" } } }))).toContain('accounts.ops.ou: "Nope"');
  });

  it("rejects an unknown SCP and an unknown target", () => {
    const msg = problems(base({ scps: { "made-up": ["root"], "region-guard": ["Nowhere"] } }));
    expect(msg).toContain("no policies/scp/made-up.json");
    expect(msg).toContain('target "Nowhere"');
  });

  it("accepts root, OU, and account targets", () => {
    const scps = { "deny-leave-org": ["root", "Workloads"], "region-guard": ["app-prod"] };
    expect(() => parseSpec(base({ scps }), SCPS)).not.toThrow();
  });

  it("allows four SCPs on one target but not five", () => {
    const names = ["a", "b", "c", "d", "e"];
    const onRoot = (n: string[]) => base({ scps: Object.fromEntries(n.map((x) => [x, ["root"]])) });
    expect(() => parseSpec(onRoot(names.slice(0, 4)), names)).not.toThrow();
    expect(() => parseSpec(onRoot(names), names)).toThrow('"root" has 5 SCPs');
  });

  it("rejects wildcard owners or repos in OIDC subjects", () => {
    for (const subject of ["repo:me/*:ref:refs/heads/main", "repo:*/app:pull_request", "*", "repo:me/app"]) {
      const accounts = { "app-prod": { ou: "Workloads/Prod", github: { deploy: { subjects: [subject] } } } };
      expect(problems(base({ accounts }))).toContain("subjects");
    }
  });

  it("allows wildcards in the subject qualifier", () => {
    const accounts = {
      "app-prod": { ou: "Workloads/Prod", github: { deploy: { subjects: ["repo:me/app:ref:refs/tags/v*"] } } },
    };
    expect(() => parseSpec(base({ accounts }), SCPS)).not.toThrow();
  });

  it("rejects non-kebab account keys", () => {
    expect(problems(base({ accounts: { AppProd: { ou: "Workloads" } } }))).toContain("lowercase kebab-case");
  });

  it("rejects names that collide as resource names", () => {
    expect(problems(base({ ous: ["Workloads/Prod", "Workloads-Prod"] }))).toContain("collide");
    expect(problems(base({ ous: ["Sandbox", "app-prod"] }))).toContain("collide");
  });

  it("requires the home region to be allowed", () => {
    expect(problems(base({ allowedRegions: ["us-west-2"] }))).toContain('include region "us-east-1"');
  });

  it("requires {account} in the email template", () => {
    expect(problems(base({ accountEmail: "me@example.com" }))).toContain("{account}");
  });

  it("rejects duplicate root emails from overrides", () => {
    const accounts = {
      "app-prod": { ou: "Workloads", email: "me+aws-app-dev@example.com" },
      "app-dev": { ou: "Workloads" },
    };
    expect(problems(base({ accounts }))).toContain("duplicate root emails");
  });

  it("reports every problem at once", () => {
    const msg = problems(base({ allowedRegions: ["us-west-2"], accounts: { ops: { ou: "Nope" } } }));
    expect(msg).toContain("allowedRegions");
    expect(msg).toContain("accounts.ops.ou");
  });
});

describe("expandOuPaths", () => {
  it("adds implied parents and orders parents first", () => {
    expect(expandOuPaths(["B/C/D", "A"])).toEqual(["A", "B", "B/C", "B/C/D"]);
  });
});

describe("accountEmail", () => {
  it("substitutes the account key unless overridden", () => {
    const spec = parseSpec(
      base({ accounts: { "app-prod": { ou: "Workloads" }, old: { ou: "Workloads", email: "x@example.com" } } }),
      SCPS,
    );
    expect(accountEmail(spec, "app-prod")).toBe("me+aws-app-prod@example.com");
    expect(accountEmail(spec, "old")).toBe("x@example.com");
  });
});
