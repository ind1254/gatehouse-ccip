/**
 * Configuration as a desired state, not as a script of transactions.
 *
 * The original configure script fired twelve writes every time it ran. That is
 * wrong in three ways at once:
 *
 *  1. It costs twelve transactions to change nothing.
 *  2. Re-running after a partial failure re-sends the steps that already
 *     succeeded, so "did it work?" has no answer short of reading the chain.
 *  3. It cannot tell you what it is about to do before it does it.
 *
 * Describing the desired state instead, then diffing it against what is
 * actually on chain, fixes all three. A converged system produces an empty
 * plan, which is a far more useful thing to see than twelve successful
 * transactions that did nothing.
 */

export interface ConfigStep<T = unknown> {
  /** Human-readable, printed in the plan. */
  description: string;
  /** What the chain should say. */
  desired: T;
  /** What the chain currently says. */
  read: () => Promise<T>;
  /** Make it so. Only called when `read()` disagrees with `desired`. */
  apply: () => Promise<unknown>;
}

export interface PlannedStep {
  description: string;
  desired: unknown;
  actual: unknown;
  needsChange: boolean;
}

export interface ConvergencePlan {
  steps: PlannedStep[];
  pending: number;
  converged: boolean;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * Read every step's current value and report what would change.
 *
 * Read-only: safe to run against production to answer "is this configured the
 * way we think it is?", which is a question worth being able to ask.
 */
export async function planConvergence(
  steps: ConfigStep[],
): Promise<ConvergencePlan> {
  const planned: PlannedStep[] = [];

  for (const step of steps) {
    let actual: unknown;
    try {
      actual = await step.read();
    } catch (error) {
      // A step whose current value cannot be read is treated as needing a
      // change rather than skipped: silently doing nothing is the failure mode
      // this whole module exists to avoid.
      planned.push({
        description: step.description,
        desired: step.desired,
        actual: `unreadable: ${String(error)}`,
        needsChange: true,
      });
      continue;
    }

    planned.push({
      description: step.description,
      desired: step.desired,
      actual,
      needsChange: !sameValue(actual, step.desired),
    });
  }

  const pending = planned.filter((step) => step.needsChange).length;
  return { steps: planned, pending, converged: pending === 0 };
}

export interface ConvergeResult {
  plan: ConvergencePlan;
  applied: string[];
  skipped: string[];
}

/**
 * Apply only the steps that differ.
 *
 * Steps run in the order given, which matters: limits and thresholds are
 * declared before the allowlist entries that make shipping possible, so a
 * partial run can never leave a desk live with no caps on it.
 */
export async function converge(
  steps: ConfigStep[],
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<ConvergeResult> {
  const plan = await planConvergence(steps);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [index, planned] of plan.steps.entries()) {
    if (!planned.needsChange) {
      skipped.push(planned.description);
      continue;
    }
    if (dryRun) continue;

    await steps[index].apply();
    applied.push(planned.description);
  }

  return { plan, applied, skipped };
}

/** Render a plan for a terminal. */
export function formatPlan(plan: ConvergencePlan): string {
  const lines = plan.steps.map((step) => {
    const mark = step.needsChange ? " ~" : "  ";
    const detail = step.needsChange
      ? `  (is ${String(step.actual)}, want ${String(step.desired)})`
      : "";
    return `${mark} ${step.description}${detail}`;
  });

  lines.push(
    "",
    plan.converged
      ? "Already converged. Nothing to send."
      : `${plan.pending} of ${plan.steps.length} steps need a transaction.`,
  );

  return lines.join("\n");
}
