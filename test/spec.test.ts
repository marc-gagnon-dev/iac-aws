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

  it("accepts GitHub's immutable repo form in selfRepo and subjects", () => {
    const accounts = {
      "app-prod": { ou: "Workloads/Prod", github: { deploy: { subjects: ["repo:me@123/app@456:ref:refs/heads/main"] } } },
    };
    expect(() => parseSpec(base({ selfRepo: "me@123/iac-aws@789", accounts }), SCPS)).not.toThrow();
  });

  it("rejects wildcards in immutable-form owners or repos", () => {
    for (const subject of ["repo:me@123/*:pull_request", "repo:me@*/app@456:pull_request"]) {
      const accounts = { "app-prod": { ou: "Workloads/Prod", github: { deploy: { subjects: [subject] } } } };
      expect(problems(base({ accounts }))).toContain("subjects");
    }
    expect(problems(base({ selfRepo: "me@abc/iac-aws" }))).toContain("selfRepo");
  });

  it("accepts a Pulumi state backend and per-role access to it", () => {
    const github = {
      deploy: { subjects: ["repo:me/app:ref:refs/heads/main"], pulumiState: "write" },
      plan: { subjects: ["repo:me/app:pull_request"], pulumiState: "read" },
      other: { subjects: ["repo:me/other:pull_request"] },
    };
    const spec = parseSpec(base({ accounts: { "app-prod": { ou: "Workloads/Prod", pulumiState: true, github } } }), SCPS);
    const acct = spec.accounts["app-prod"];
    expect(acct.pulumiState).toBe(true);
    expect(acct.github.deploy.pulumiState).toBe("write");
    expect(acct.github.plan.pulumiState).toBe("read");
    expect(acct.github.other.pulumiState).toBeUndefined();
    expect(parseSpec(base(), SCPS).accounts["app-prod"].pulumiState).toBe(false);
  });

  it("rejects state access on a role whose account has no state backend", () => {
    const github = { deploy: { subjects: ["repo:me/app:ref:refs/heads/main"], pulumiState: "write" } };
    expect(problems(base({ accounts: { "app-prod": { ou: "Workloads/Prod", github } } }))).toContain(
      "accounts.app-prod.github.deploy.pulumiState: app-prod has no state backend; set pulumiState: true on the account",
    );
  });

  it("rejects unknown state access levels", () => {
    const github = { deploy: { subjects: ["repo:me/app:ref:refs/heads/main"], pulumiState: "admin" } };
    expect(problems(base({ accounts: { "app-prod": { ou: "Workloads/Prod", pulumiState: true, github } } }))).toContain(
      "pulumiState",
    );
  });

  it("reserves root and management as account keys", () => {
    for (const key of ["root", "management"]) {
      expect(problems(base({ accounts: { [key]: { ou: "Workloads" } } }))).toContain(`"${key}" is reserved`);
    }
  });

  it("validates identityCenter admins", () => {
    const admin = { email: "me@example.com", givenName: "Me", familyName: "Too" };
    expect(parseSpec(base({ identityCenter: { admins: [admin] } }), SCPS).identityCenter?.sessionHours).toBe(8);
    expect(problems(base({ identityCenter: { admins: [] } }))).toContain("identityCenter.admins");
    expect(problems(base({ identityCenter: { admins: [{ ...admin, email: "nope" }] } }))).toContain("identityCenter.admins");
    expect(problems(base({ identityCenter: { admins: [admin, { ...admin, email: "ME@example.com" }] } }))).toContain(
      "duplicate me@example.com",
    );
    expect(problems(base({ identityCenter: { admins: [admin], sessionHours: 13 } }))).toContain("sessionHours");
  });

  it("validates budgets", () => {
    const budgets = { emails: ["me@example.com"], monthly: { organization: 100, management: 5, "app-prod": 50 } };
    expect(parseSpec(base({ budgets }), SCPS).budgets?.alerts).toEqual([50, 80, 100]);
    expect(problems(base({ budgets: { ...budgets, monthly: { nope: 10 } } }))).toContain("budgets.monthly.nope");
    expect(problems(base({ budgets: { ...budgets, monthly: { organization: 0 } } }))).toContain("budgets.monthly");
    expect(problems(base({ budgets: { ...budgets, emails: [] } }))).toContain("budgets.emails");
    expect(problems(base({ budgets: { ...budgets, alerts: [50, 50] } }))).toContain("duplicate percentages");
    expect(problems(base({ budgets: { ...budgets, alerts: [10, 20, 30, 40, 50], forecastAlert: 100 } }))).toContain(
      "6 alerts",
    );
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
