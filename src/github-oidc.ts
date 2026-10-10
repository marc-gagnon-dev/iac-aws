import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
export const GITHUB_AUDIENCE = "sts.amazonaws.com";

export interface GithubRole {
  /** Full IAM role name. */
  name: string;
  /** OIDC `sub` patterns, e.g. repo:acme/app:ref:refs/heads/main. */
  subjects: string[];
  /** Managed policy ARNs to attach. */
  policies: string[];
  /** Optional inline policy document (JSON). */
  inlinePolicy?: pulumi.Input<string>;
  maxSessionHours: number;
}

/** Trust policy letting GitHub Actions jobs whose `sub` matches one of `subjects` assume the role. */
export function trustPolicy(providerArn: string, subjects: string[]): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Federated: providerArn },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: GITHUB_AUDIENCE },
          StringLike: { [`${GITHUB_OIDC_HOST}:sub`]: subjects },
        },
      },
    ],
  });
}

export interface GithubOidcTrustArgs {
  /** Provider for the account the trust lives in. */
  provider: aws.Provider;
  roles: GithubRole[];
}

/** GitHub's OIDC identity provider in one account, plus the roles GitHub Actions may assume there. */
export class GithubOidcTrust extends pulumi.ComponentResource {
  readonly providerArn: pulumi.Output<string>;
  readonly roleArns: Record<string, pulumi.Output<string>>;

  constructor(name: string, args: GithubOidcTrustArgs, opts?: pulumi.ComponentResourceOptions) {
    super("iac-aws:index:GithubOidcTrust", name, {}, opts);
    const child = { parent: this, provider: args.provider };

    // AWS validates GitHub's certificate against its own trusted CAs, so no thumbprint is needed.
    const oidc = new aws.iam.OpenIdConnectProvider(
      `${name}-github`,
      { url: `https://${GITHUB_OIDC_HOST}`, clientIdLists: [GITHUB_AUDIENCE] },
      child,
    );
    this.providerArn = oidc.arn;

    this.roleArns = {};
    for (const spec of args.roles) {
      const role = new aws.iam.Role(
        `${name}-${spec.name}`,
        {
          name: spec.name,
          assumeRolePolicy: oidc.arn.apply((arn) => trustPolicy(arn, spec.subjects)),
          maxSessionDuration: spec.maxSessionHours * 3600,
          description: "GitHub Actions OIDC role managed by iac-aws",
        },
        child,
      );
      for (const policyArn of spec.policies) {
        new aws.iam.RolePolicyAttachment(
          `${name}-${spec.name}-${policyArn.split("/").pop()}`,
          { role: role.name, policyArn },
          child,
        );
      }
      if (spec.inlinePolicy) {
        new aws.iam.RolePolicy(`${name}-${spec.name}-inline`, { role: role.name, policy: spec.inlinePolicy }, child);
      }
      this.roleArns[spec.name] = role.arn;
    }

    this.registerOutputs({ providerArn: this.providerArn, roleArns: this.roleArns });
  }
}
