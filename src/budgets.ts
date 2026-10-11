import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { Spec } from "./spec";

/** budgets.monthly key for one budget covering every account together. */
export const ORGANIZATION_BUDGET = "organization";

/**
 * Monthly cost budgets, all kept in the management account so member-account admins can't
 * remove them. Consolidated billing lets one place filter by linked account.
 */
export function createBudgets(
  spec: Spec,
  provider: aws.Provider,
  /** Account IDs by budgets.monthly key: "management" and every account key. */
  accountIds: Record<string, pulumi.Input<string>>,
): void {
  const b = spec.budgets;
  if (!b) return;

  const notifications = [
    ...b.alerts.map((threshold) => ({ threshold, notificationType: "ACTUAL" })),
    ...(b.forecastAlert === undefined ? [] : [{ threshold: b.forecastAlert, notificationType: "FORECASTED" }]),
  ].map((n) => ({
    ...n,
    comparisonOperator: "GREATER_THAN",
    thresholdType: "PERCENTAGE",
    subscriberEmailAddresses: b.emails,
  }));

  for (const [key, amount] of Object.entries(b.monthly)) {
    new aws.budgets.Budget(
      `budget-${key}`,
      {
        name: `iac-aws-${key}`,
        budgetType: "COST",
        limitAmount: String(amount),
        limitUnit: "USD",
        timeUnit: "MONTHLY",
        costFilters: key === ORGANIZATION_BUDGET ? [] : [{ name: "LinkedAccount", values: [accountIds[key]] }],
        notifications,
      },
      { provider },
    );
  }
}
