import { describe, expect, it } from "vitest";
import { trustPolicy } from "../src/github-oidc";

describe("trustPolicy", () => {
  it("pins the audience and matches subjects", () => {
    const doc = JSON.parse(trustPolicy("arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com", [
      "repo:me/app:ref:refs/heads/main",
      "repo:me/app:environment:production",
    ]));
    const [statement] = doc.Statement;
    expect(statement.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(statement.Principal.Federated).toContain(":oidc-provider/token.actions.githubusercontent.com");
    expect(statement.Condition.StringEquals).toEqual({ "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" });
    expect(statement.Condition.StringLike["token.actions.githubusercontent.com:sub"]).toEqual([
      "repo:me/app:ref:refs/heads/main",
      "repo:me/app:environment:production",
    ]);
  });
});
