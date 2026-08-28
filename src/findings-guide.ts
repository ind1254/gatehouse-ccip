/**
 * Operator guidance for each reconciliation finding.
 *
 * Kept as static data rather than generated prose so the advice an operator
 * reads at 3am is the advice that was reviewed in daylight.
 */

export interface FindingGuide {
  meaning: string;
  causes: string[];
  check: string[];
  severity: "info" | "warn" | "alarm";
}

export const FINDING_GUIDE: Record<string, FindingGuide> = {
  MESSAGES_IN_FLIGHT: {
    severity: "info",
    meaning:
      "Messages have been shipped and are still within the expected delivery " +
      "window for this lane.",
    causes: [
      "Normal operation. Cross-chain delivery is dominated by source-chain " +
        "finality and takes minutes, not seconds.",
    ],
    check: [
      "Nothing. This is the state every healthy message passes through.",
      "If the count keeps growing and never drains, the lane is stuck rather " +
        "than slow.",
    ],
  },
  MESSAGE_OVERDUE: {
    severity: "warn",
    meaning:
      "A message has passed the expected delivery window for its lane and has " +
      "still not been recorded by the receiving desk.",
    causes: [
      "The lane is congested or slower than the configured expectation.",
      "The message failed on the destination and is awaiting manual execution.",
      "The expected latency is configured too low for this lane.",
    ],
    check: [
      "Look the messageId up on the CCIP explorer and read its state.",
      "Check whether the inbox is paused or its rate-limit window is exhausted.",
      "A FAILED message can be manually executed. Nothing is lost yet.",
    ],
  },
  MESSAGE_MISSING: {
    severity: "alarm",
    meaning:
      "A message is far past its expected delivery window. Treat it as lost " +
      "until proven otherwise.",
    causes: [
      "It was delivered to an address with no contract code. CCIP reports that " +
        "as a success and the cargo settles at the wrong address permanently.",
      "It failed on the destination and nobody has executed it manually.",
      "Too little destination gas was purchased for the receiver as it is now.",
    ],
    check: [
      "Confirm the receiver address has contract code. If it does not, the " +
        "cargo is not recoverable and the destination allowlist should be " +
        "tightened so it cannot happen again.",
      "Check the CCIP explorer. A FAILED message can still be executed.",
      "Compare destinationGasLimit against what the receiver now costs to run.",
    ],
  },
  UNACCOUNTED_MINT: {
    severity: "alarm",
    meaning:
      "Tokens were minted directly to the receiving desk, outside any recorded " +
      "delivery.",
    causes: [
      "An unbacked mint: tokens exist on the destination with no matching burn " +
        "on the source. This is what a bridge exploit looks like from this side.",
      "A token administrator minted deliberately, without telling the bridge.",
    ],
    check: [
      "Pause immediately. This is the case the emergency stop exists for.",
      "Compare aggregate supply across both chains.",
      "Identify who holds mint authority on the destination token and whether " +
        "that key is still trustworthy.",
    ],
  },
  UNSETTLED_MESSAGE: {
    severity: "alarm",
    meaning:
      "A message left the shipping desk and the receiving desk never recorded " +
      "it arriving.",
    causes: [
      "It is still in flight. Cross-chain delivery takes minutes, not seconds.",
      "It was delivered to an address with no contract code, which CCIP " +
        "reports as a success while the cargo settles at the wrong address " +
        "permanently.",
      "It failed on the destination - a paused inbox, a rate limit, a revoked " +
        "allowlist entry, or too little destination gas - and is waiting for " +
        "manual execution.",
    ],
    check: [
      "Compare the message age against normal lane latency before treating it " +
        "as lost.",
      "Confirm the receiver address is the expected inbox and has contract code.",
      "Check the CCIP explorer for the message state; a FAILED message can be " +
        "manually executed.",
      "Check whether the inbox is paused or its rate-limit window is exhausted.",
    ],
  },
  LEDGER_GAP: {
    severity: "alarm",
    meaning:
      "The source desk has shipped more of a token than the destination desk " +
      "accounts for as received or held.",
    causes: [
      "The same causes as UNSETTLED_MESSAGE, seen in aggregate rather than " +
        "per message.",
      "Cargo stranded at an address that cannot receive it.",
    ],
    check: [
      "Identify which messages are unsettled and trace each one.",
      "A gap that does not close as messages settle is a real loss, not " +
        "latency.",
    ],
  },
  UNACCOUNTED_BALANCE: {
    severity: "warn",
    meaning:
      "The receiving desk holds more of a token than its own books explain.",
    causes: [
      "Someone sent tokens straight to the desk address with a plain ERC-20 " +
        "transfer. The contract's code never ran, so nothing was recorded.",
      "A donation, a refund, or a mistake by another operator.",
    ],
    check: [
      "Look at the token's transfer events into the desk and find one with no " +
        "matching CCIP delivery.",
      "Never treat a balance as proof of a delivery. Anyone can change a " +
        "balance without the contract's permission.",
    ],
  },
  RELEASE_DUE: {
    severity: "warn",
    meaning:
      "Cargo that was held for exceeding the large-transfer threshold has " +
      "passed its release time and is still held.",
    causes: [
      "Nobody has called releaseCargo yet. Release is permissionless but not " +
        "automatic.",
      "The desk is paused, which blocks release on purpose.",
    ],
    check: [
      "If the transfer is legitimate, call releaseCargo; anyone may do it.",
      "If it is not, this is the window the delay exists to give you. Pause " +
        "before releasing.",
    ],
  },
  INBOX_PAUSED: {
    severity: "info",
    meaning: "The receiving desk is paused. This is a deliberate action.",
    causes: ["A guardian or the owner paused it."],
    check: [
      "Arriving deliveries revert while paused. They are not lost and can be " +
        "re-executed after unpausing.",
      "Only the owner can unpause, and only after the incident is understood.",
    ],
  },
  OUTBOX_PAUSED: {
    severity: "info",
    meaning: "The shipping desk is paused. This is a deliberate action.",
    causes: ["A guardian or the owner paused it."],
    check: [
      "No new shipments can leave. Messages already in flight are unaffected.",
    ],
  },
};
