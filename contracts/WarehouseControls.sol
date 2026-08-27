// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title WarehouseControls
/// @notice Controls shared by both desks: a pause with a split key, and a
///         rolling-window rate limit.
/// @dev Everything here works regardless of WHO is asking. The allowlists in
///      Checkpoints 3 and 4 authenticate a caller; these limits bound what any
///      caller - including a compromised but still-allowlisted one - can do.
abstract contract WarehouseControls is Ownable, Pausable {
    /// @notice A budget for one token over one rolling window.
    /// @dev Mirrors the shape of Chainlink's own rate limiter config: the
    ///      limit is opt-in, so `enabled` is explicit rather than inferred
    ///      from a zero amount.
    struct Limit {
        bool enabled;
        uint256 amountPerWindow;
        uint256 windowSeconds;
    }

    /// @notice The configured budget per token.
    /// @dev The zero address is a bucket for DELIVERY COUNT, not a token: every
    ///      message consumes 1 from it. That is what bounds a flood of
    ///      individually-valid messages.
    mapping(address token => Limit) public limit;

    /// @notice When the current window for a token opened.
    mapping(address token => uint256 startedAt) public windowStartedAt;

    /// @notice How much of the current window's budget is spent.
    mapping(address token => uint256 used) public windowUsed;

    /// @notice May pause, but may not unpause.
    /// @dev Deliberately split. Pausing is an emergency action that should live
    ///      on a fast, hot key. Unpausing declares the emergency over and stays
    ///      with the owner, which should be a cold key or a multisig.
    address public guardian;

    /// @notice The delivery-count bucket. Not a real token.
    address public constant MESSAGE_COUNT_BUCKET = address(0);

    event GuardianSet(address indexed guardian);
    event LimitSet(
        address indexed token,
        bool enabled,
        uint256 amountPerWindow,
        uint256 windowSeconds
    );
    event WindowRolled(address indexed token, uint256 startedAt);

    error NotGuardianOrOwner(address caller);
    error RateLimitExceeded(
        address token,
        uint256 requested,
        uint256 used,
        uint256 amountPerWindow
    );
    error InvalidLimitWindow();

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ------------------------------------------------------------------ pause

    /// @notice Stop new activity immediately.
    /// @dev Either the guardian or the owner may pause. Speed matters here.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) {
            revert NotGuardianOrOwner(msg.sender);
        }
        _pause();
    }

    /// @notice Declare the emergency over.
    /// @dev Owner only. Restarting a bridge is a decision, not a reflex.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Appoint the account that may hit the emergency stop.
    function setGuardian(address newGuardian) external onlyOwner {
        guardian = newGuardian;
        emit GuardianSet(newGuardian);
    }

    // ------------------------------------------------------------- rate limit

    /// @notice Configure the budget for one token, or for the message counter.
    function setLimit(
        address token,
        bool enabled,
        uint256 amountPerWindow,
        uint256 windowSeconds
    ) external onlyOwner {
        if (enabled && windowSeconds == 0) revert InvalidLimitWindow();

        limit[token] = Limit({
            enabled: enabled,
            amountPerWindow: amountPerWindow,
            windowSeconds: windowSeconds
        });

        emit LimitSet(token, enabled, amountPerWindow, windowSeconds);
    }

    /// @notice What is still spendable in the current window.
    /// @dev Reports the fresh budget if the window has already expired, so a
    ///      caller sees what they would actually get, not stale bookkeeping.
    function remainingAllowance(address token) public view returns (uint256) {
        Limit memory configured = limit[token];
        if (!configured.enabled) return type(uint256).max;

        if (block.timestamp >= windowStartedAt[token] + configured.windowSeconds) {
            return configured.amountPerWindow;
        }

        uint256 spent = windowUsed[token];
        if (spent >= configured.amountPerWindow) return 0;
        return configured.amountPerWindow - spent;
    }

    /// @dev Spend from a token's budget, rolling the window first if it has
    ///      expired. Reverts if the budget cannot cover the request.
    function _consumeLimit(address token, uint256 amount) internal {
        Limit memory configured = limit[token];
        if (!configured.enabled) return;

        if (block.timestamp >= windowStartedAt[token] + configured.windowSeconds) {
            windowStartedAt[token] = block.timestamp;
            windowUsed[token] = 0;
            emit WindowRolled(token, block.timestamp);
        }

        uint256 spent = windowUsed[token];
        if (spent + amount > configured.amountPerWindow) {
            revert RateLimitExceeded(
                token,
                amount,
                spent,
                configured.amountPerWindow
            );
        }

        windowUsed[token] = spent + amount;
    }
}
