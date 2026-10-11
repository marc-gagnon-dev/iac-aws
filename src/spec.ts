import * as fs from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

/** Number of SCPs a single target can carry, minus the AWS-managed FullAWSAccess that is always attached. */
export const MAX_CUSTOM_SCPS_PER_TARGET = 4;

const ACCOUNT_KEY = /^[a-z][a-z0-9-]{1,48}[a-z0-9]$/;
const OU_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,127}$/;
// <owner>/<repo>, or GitHub's immutable form <owner>@<owner-id>/<repo>@<repo-id>. Repos created
// after 2026-07-15 put the immutable form in their OIDC subject, so trust must use it verbatim.
const REPO = /^[A-Za-z0-9_.-]+(@\d+)?\/[A-Za-z0-9_.-]+(@\d+)?$/;
// repo:<repo>:<qualifier>, <repo> as above. Owner and repo are literal; only the qualifier may use wildcards.
const SUBJECT = /^repo:[A-Za-z0-9_.-]+(@\d+)?\/[A-Za-z0-9_.-]+(@\d+)?:[^\s]+$/;
const ROLE_KEY = /^[a-z][a-z0-9-]{0,40}$/;

const githubRole = z.object({
  subjects: z.array(z.string().regex(SUBJECT, "must look like repo:<owner>/<repo>:<qualifier> (or repo:<owner>@<id>/<repo>@<id>:<qualifier>) with no wildcard in owner or repo")).min(1),
  policies: z.array(z.string().startsWith("arn:aws:iam::")).default([]),
  maxSessionHours: z.number().int().min(1).max(12).default(1),
});

const account = z.object({
  ou: z.string(),
  /** Adopt an existing member account instead of creating one. */
  id: z.string().regex(/^\d{12}$/).optional(),
  /** Overrides for adopted accounts whose name or email predate this spec. */
  name: z.string().optional(),
  email: z.email().optional(),
  closeOnDeletion: z.boolean().default(false),
  github: z.record(z.string(), githubRole).default({}),
});

const schema = z.object({
  region: z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/),
  accountEmail: z.string().includes("{account}", { message: "must contain {account}" }),
  selfRepo: z.string().regex(REPO, "must be <owner>/<repo> or <owner>@<id>/<repo>@<id>"),
  allowedRegions: z.array(z.string()).min(1),
  ous: z.array(z.string()).default([]),
  scps: z.record(z.string(), z.array(z.string()).min(1)).default({}),
  accounts: z.record(z.string(), account).default({}),
});

export type Spec = z.infer<typeof schema>;
export type AccountSpec = z.infer<typeof account>;
export type GithubRoleSpec = z.infer<typeof githubRole>;

/** A target an SCP can attach to. */
export type ScpTarget = { kind: "root" } | { kind: "ou"; path: string } | { kind: "account"; key: string };

/** Every declared OU path plus its implied parents, parents before children. */
export function expandOuPaths(paths: string[]): string[] {
  const all = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let i = 1; i <= segments.length; i++) all.add(segments.slice(0, i).join("/"));
  }
  return [...all].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** Resource-name-safe form of an OU path or account key. */
export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function parentOf(path: string): string | undefined {
  const i = path.lastIndexOf("/");
  return i === -1 ? undefined : path.slice(0, i);
}

export function accountEmail(spec: Spec, key: string): string {
  return spec.accounts[key]?.email ?? spec.accountEmail.split("{account}").join(key);
}

export function resolveTarget(spec: Spec, target: string): ScpTarget {
  if (target === "root") return { kind: "root" };
  if (target in spec.accounts) return { kind: "account", key: target };
  return { kind: "ou", path: target };
}

/** Parse and cross-check a spec. Throws with every problem listed, not just the first. */
export function parseSpec(raw: unknown, availableScps: string[]): Spec {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error(`org.yaml is invalid:\n${z.prettifyError(result.error)}`);
  const spec = result.data;
  const problems: string[] = [];

  for (const path of spec.ous) {
    if (path === "root") problems.push(`ous: "root" is reserved for the organization root`);
    if (!path.split("/").every((s) => OU_SEGMENT.test(s))) problems.push(`ous: "${path}" has an invalid segment`);
  }
  const ous = new Set(expandOuPaths(spec.ous));
  const slugs = new Map<string, string>();
  for (const name of [...ous, ...Object.keys(spec.accounts)]) {
    const other = slugs.get(slug(name));
    if (other) problems.push(`"${name}" and "${other}" collide as resource names; rename one`);
    slugs.set(slug(name), name);
  }
  for (const [key, acct] of Object.entries(spec.accounts)) {
    if (!ACCOUNT_KEY.test(key)) problems.push(`accounts.${key}: key must be lowercase kebab-case, 3-50 characters`);
    for (const role of Object.keys(acct.github)) {
      if (!ROLE_KEY.test(role)) problems.push(`accounts.${key}.github.${role}: role key must be lowercase kebab-case`);
    }
    if (!ous.has(acct.ou)) problems.push(`accounts.${key}.ou: "${acct.ou}" is not declared in ous`);
  }

  const perTarget = new Map<string, string[]>();
  for (const [scp, targets] of Object.entries(spec.scps)) {
    if (!availableScps.includes(scp)) {
      problems.push(`scps.${scp}: no policies/scp/${scp}.json (available: ${availableScps.join(", ")})`);
    }
    for (const target of targets) {
      if (target !== "root" && !ous.has(target) && !(target in spec.accounts)) {
        problems.push(`scps.${scp}: target "${target}" is not root, a declared OU, or an account key`);
      }
      perTarget.set(target, [...(perTarget.get(target) ?? []), scp]);
    }
  }
  for (const [target, scps] of perTarget) {
    if (scps.length > MAX_CUSTOM_SCPS_PER_TARGET) {
      problems.push(`scps: "${target}" has ${scps.length} SCPs; AWS allows ${MAX_CUSTOM_SCPS_PER_TARGET} plus FullAWSAccess`);
    }
  }

  if (!spec.allowedRegions.includes(spec.region)) problems.push(`allowedRegions must include region "${spec.region}"`);

  const emails = Object.keys(spec.accounts).map((k) => accountEmail(spec, k).toLowerCase());
  const dupes = emails.filter((e, i) => emails.indexOf(e) !== i);
  if (dupes.length) problems.push(`accounts: duplicate root emails ${[...new Set(dupes)].join(", ")}`);

  if (problems.length) throw new Error(`org.yaml is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return spec;
}

export function loadSpec(file: string, availableScps: string[]): Spec {
  if (!fs.existsSync(file)) {
    throw new Error(`${file} not found. Copy org.example.yaml to org.yaml and describe your organization.`);
  }
  return parseSpec(parse(fs.readFileSync(file, "utf8")), availableScps);
}
