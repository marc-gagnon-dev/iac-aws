import * as fs from "node:fs";
import * as path from "node:path";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { resolveTarget, slug, Spec } from "./spec";

export const SCP_DIR = path.join(__dirname, "..", "policies", "scp");

/** AWS limit on SCP document size, measured after whitespace is removed. */
export const MAX_SCP_CHARS = 5120;

export function availableScps(dir = SCP_DIR): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/** Template variables a policy may reference as a whole JSON string, e.g. "{{allowedRegions}}". */
export function templateVars(spec: Spec): Record<string, unknown> {
  return { allowedRegions: spec.allowedRegions };
}

/** Substitute "{{var}}" string values and minify. Throws if a variable is unknown or the result is too large. */
export function renderScp(name: string, source: string, vars: Record<string, unknown>): string {
  const substitute = (value: unknown): unknown => {
    if (typeof value === "string") {
      const match = /^\{\{(\w+)\}\}$/.exec(value);
      if (!match) return value;
      if (!(match[1] in vars)) throw new Error(`SCP ${name}: unknown template variable {{${match[1]}}}`);
      return vars[match[1]];
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
    }
    return value;
  };
  const rendered = JSON.stringify(substitute(JSON.parse(source)));
  if (rendered.length > MAX_SCP_CHARS) {
    throw new Error(`SCP ${name} is ${rendered.length} characters; AWS allows ${MAX_SCP_CHARS}`);
  }
  return rendered;
}

export interface ScpTargets {
  rootId: pulumi.Input<string>;
  ouIds: Record<string, pulumi.Input<string>>;
  accountIds: Record<string, pulumi.Input<string>>;
}

/** Create every SCP named in the spec and attach it to its targets. */
export function attachScps(spec: Spec, targets: ScpTargets, provider: aws.Provider): void {
  const vars = templateVars(spec);
  for (const [name, targetNames] of Object.entries(spec.scps)) {
    const content = renderScp(name, fs.readFileSync(path.join(SCP_DIR, `${name}.json`), "utf8"), vars);
    const policy = new aws.organizations.Policy(
      `scp-${name}`,
      { name, type: "SERVICE_CONTROL_POLICY", content, description: `iac-aws: ${name}` },
      { provider },
    );
    for (const targetName of targetNames) {
      const target = resolveTarget(spec, targetName);
      const targetId =
        target.kind === "root" ? targets.rootId : target.kind === "ou" ? targets.ouIds[target.path] : targets.accountIds[target.key];
      new aws.organizations.PolicyAttachment(
        `scp-${name}--${slug(targetName)}`,
        { policyId: policy.id, targetId },
        { provider },
      );
    }
  }
}
