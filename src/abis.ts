import { parseAbi } from "viem";

/**
 * Hand-written ABIs for the parts of each desk the operator tooling reads.
 *
 * Deliberately not imported from `artifacts/`: the tooling should be readable
 * on its own and should not need a compile before it can run. If a signature
 * here drifts from the contract, the tests in `test/Reconciliation.ts` fail,
 * because they run this exact code against freshly compiled contracts.
 */

export const outboxAbi = parseAbi([
  // state
  "function totalShipped(address token) view returns (uint256)",
  "function shippedCount() view returns (uint256)",
  "function destinationGasLimit() view returns (uint256)",
  "function paused() view returns (bool)",
  "function guardian() view returns (address)",
  "function owner() view returns (address)",
  "function remainingAllowance(address token) view returns (uint256)",
  "function limit(address token) view returns (bool enabled, uint256 amountPerWindow, uint256 windowSeconds)",
  // events
  "event DeliveryShipped(bytes32 indexed messageId, uint64 indexed destinationChainSelector, address indexed receiver, string message, uint256 fee)",
  "event CargoShipped(bytes32 indexed messageId, address indexed token, uint256 amount)",
]);

export const inboxAbi = parseAbi([
  // state
  "function totalReceived(address token) view returns (uint256)",
  "function totalHeld(address token) view returns (uint256)",
  "function cargoBalance(address token) view returns (uint256)",
  "function withdrawableCargo(address token) view returns (uint256)",
  "function deliveryCount() view returns (uint256)",
  "function releaseDelay() view returns (uint256)",
  "function processedMessages(bytes32 messageId) view returns (bool)",
  "function heldCargo(bytes32 messageId) view returns (address token, uint256 amount, uint256 releasableAt, bool released)",
  "function paused() view returns (bool)",
  "function guardian() view returns (address)",
  "function owner() view returns (address)",
  "function remainingAllowance(address token) view returns (uint256)",
  "function limit(address token) view returns (bool enabled, uint256 amountPerWindow, uint256 windowSeconds)",
  // events
  "event DeliveryReceived(bytes32 indexed messageId, uint64 indexed sourceChainSelector, address indexed sourceWarehouse, string message)",
  "event CargoReceived(bytes32 indexed messageId, address indexed token, uint256 amount)",
  "event CargoHeld(bytes32 indexed messageId, address indexed token, uint256 amount, uint256 releasableAt)",
  "event CargoReleased(bytes32 indexed messageId, address indexed token, uint256 amount)",
]);

/// Writes are kept in their own ABI so a read-only tool cannot reach them.
export const controlsWriteAbi = parseAbi([
  "function pause()",
  "function unpause()",
]);
