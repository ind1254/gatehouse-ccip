// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title WarehouseControls
/// @notice Controls shared by both desks: separated admin powers, an asymmetric
///         timelock, a split-key pause, and lane-scoped token-bucket limits.
/// @dev Everything here bounds what ANY caller can do. The allowlists in the
///      desks authenticate a caller; these limits constrain one that is
///      authenticated, allowlisted, and compromised.
abstract contract WarehouseControls is Ownable2Step, Pausable {
    // ------------------------------------------------------------------ roles

    /// @dev May pause, and may cancel a scheduled widening. Meant for a hot key.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN");

    /// @dev May edit allowlists, limits, and thresholds. Meant for a warm key.
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG");

    /// @dev May move funds out of a desk. Meant for a cold key.
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY");

    /// @notice Who holds which role.
    /// @dev The owner is deliberately NOT granted an implicit bypass. If the
    ///      owner wants to withdraw, it must grant itself TREASURY_ROLE, and
    ///      granting a role is a widening change - so with a delay configured
    ///      that escalation is scheduled, visible, and cancellable rather than
    ///      instant. An owner that could do everything directly would make the
    ///      separation decorative.
    mapping(bytes32 role => mapping(address account => bool held)) public hasRole;

    // ------------------------------------------------------------- rate limit

    /// @notice A token bucket: a burst allowance that refills continuously.
    /// @dev The rate is expressed as `refillAmount` per `refillPeriod` rather
    ///      than per second, because integer per-second maths rounds a rate
    ///      like "5 per hour" down to zero.
    struct Limit {
        bool enabled;
        uint256 capacity;
        uint256 refillAmount;
        uint256 refillPeriod;
    }

    struct Bucket {
        uint256 available;
        uint256 lastRefillAt;
    }

    /// @notice Budgets, per lane and per token.
    /// @dev Keyed by the PAIR for the same reason the source allowlist is: one
    ///      lane's traffic must not consume another lane's budget.
    ///      `ALL_LANES` is an aggregate bucket consumed alongside the specific
    ///      one, so a global cap can bound total blast radius.
    ///      `MESSAGE_COUNT_BUCKET` counts messages rather than tokens.
    mapping(uint64 lane => mapping(address token => Limit)) public limit;

    mapping(uint64 lane => mapping(address token => Bucket)) internal buckets;

    /// @notice The aggregate bucket. Zero is not a valid CCIP chain selector.
    uint64 public constant ALL_LANES = 0;

    /// @notice The delivery-count bucket. Not a real token.
    address public constant MESSAGE_COUNT_BUCKET = address(0);

    // --------------------------------------------------------------- timelock

    /// @notice How long a widening change must wait. Zero means immediate.
    uint256 public trustDelay;

    /// @notice Scheduled widening changes, by action id, and when each matures.
    mapping(bytes32 actionId => uint256 readyAt) public scheduled;

    // ----------------------------------------------------------------- events

    event RoleSet(bytes32 indexed role, address indexed account, bool granted);
    event TrustDelaySet(uint256 trustDelay);
    event ActionScheduled(bytes32 indexed actionId, uint256 readyAt);
    event ActionCancelled(bytes32 indexed actionId);
    event LimitSet(
        uint64 indexed lane,
        address indexed token,
        bool enabled,
        uint256 capacity,
        uint256 refillAmount,
        uint256 refillPeriod
    );

    // ----------------------------------------------------------------- errors

    error MissingRole(bytes32 role, address caller);
    error RateLimitExceeded(
        uint64 lane,
        address token,
        uint256 requested,
        uint256 available
    );
    error InvalidLimitConfig();
    error ActionNotScheduled(bytes32 actionId);
    error ActionNotReady(bytes32 actionId, uint256 readyAt);

    // -------------------------------------------------------------- modifiers

    modifier onlyRole(bytes32 role) {
        if (!hasRole[role][msg.sender]) revert MissingRole(role, msg.sender);
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {
        // A fresh deployment is operable by its deployer. Splitting these onto
        // separate keys is a deployment step, not a contract change - see
        // docs/adr/0008-separated-powers-and-asymmetric-timelock.md.
        _setRole(GUARDIAN_ROLE, initialOwner, true);
        _setRole(CONFIG_ROLE, initialOwner, true);
        _setRole(TREASURY_ROLE, initialOwner, true);
    }

    // ------------------------------------------------------------------ roles

    /// @notice Grant or revoke a role.
    /// @dev Granting is widening and is subject to the timelock. Revoking is
    ///      tightening and is always immediate.
    function setRole(
        bytes32 role,
        address account,
        bool granted
    ) external onlyOwner {
        _requireDelayIfWidening(granted);
        _setRole(role, account, granted);
    }

    function _setRole(bytes32 role, address account, bool granted) internal {
        hasRole[role][account] = granted;
        emit RoleSet(role, account, granted);
    }

    /// @notice Set how long a widening change must wait before it can execute.
    /// @dev Lowering the delay is itself widening, so it is subject to the
    ///      delay currently in force. Raising it is immediate.
    function setTrustDelay(uint256 newTrustDelay) external onlyOwner {
        _requireDelayIfWidening(newTrustDelay < trustDelay);
        trustDelay = newTrustDelay;
        emit TrustDelaySet(newTrustDelay);
    }

    // ------------------------------------------------------------------ pause

    /// @notice Stop new activity immediately.
    /// @dev Guardian or owner. Speed matters here.
    function pause() external {
        if (!hasRole[GUARDIAN_ROLE][msg.sender] && msg.sender != owner()) {
            revert MissingRole(GUARDIAN_ROLE, msg.sender);
        }
        _pause();
    }

    /// @notice Declare the emergency over.
    /// @dev Owner only. Restarting a bridge is a decision, not a reflex.
    function unpause() external onlyOwner {
        _unpause();
    }

    // --------------------------------------------------------------- timelock

    /// @notice The id of a specific call, arguments included.
    /// @dev The id is the calldata itself, so a schedule authorises exactly one
    ///      call with exactly one set of arguments - not a category of call.
    function actionIdFor(bytes calldata callData) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), callData));
    }

    /// @notice Announce a widening change, starting its delay.
    function scheduleAction(bytes32 actionId) external onlyRole(CONFIG_ROLE) {
        uint256 readyAt = block.timestamp + trustDelay;
        scheduled[actionId] = readyAt;
        emit ActionScheduled(actionId, readyAt);
    }

    /// @notice Abandon a scheduled change.
    /// @dev Guardian or config admin: cancelling is tightening, and during an
    ///      incident the hot key must be able to stop a pending widening.
    function cancelAction(bytes32 actionId) external {
        if (
            !hasRole[GUARDIAN_ROLE][msg.sender] &&
            !hasRole[CONFIG_ROLE][msg.sender]
        ) {
            revert MissingRole(GUARDIAN_ROLE, msg.sender);
        }
        delete scheduled[actionId];
        emit ActionCancelled(actionId);
    }

    /// @dev Enforce the delay on a widening change, and consume the schedule.
    ///      Tightening changes never wait: making a system stricter is always
    ///      safe to do immediately.
    function _requireDelayIfWidening(bool widening) internal {
        if (!widening || trustDelay == 0) return;

        bytes32 actionId = keccak256(abi.encode(address(this), msg.data));
        uint256 readyAt = scheduled[actionId];

        if (readyAt == 0) revert ActionNotScheduled(actionId);
        if (block.timestamp < readyAt) revert ActionNotReady(actionId, readyAt);

        delete scheduled[actionId];
    }

    // ------------------------------------------------------------- rate limit

    /// @notice Configure a budget for one token on one lane.
    /// @dev Raising capacity, or disabling a limit, is widening: an
    ///      unconfigured limit is unlimited, so turning one off removes the cap
    ///      entirely. Lowering or enabling is tightening and takes effect now.
    function setLimit(
        uint64 lane,
        address token,
        Limit calldata config
    ) external onlyRole(CONFIG_ROLE) {
        if (config.enabled && (config.refillPeriod == 0 || config.capacity == 0)) {
            revert InvalidLimitConfig();
        }

        Limit memory current = limit[lane][token];
        bool widening = !config.enabled
            ? current.enabled
            : (!current.enabled ? false : config.capacity > current.capacity);
        _requireDelayIfWidening(widening);

        limit[lane][token] = config;

        // A newly enabled bucket starts full, so enabling a limit does not
        // block the next action outright.
        if (config.enabled && !current.enabled) {
            buckets[lane][token] = Bucket({
                available: config.capacity,
                lastRefillAt: block.timestamp
            });
        }

        emit LimitSet(
            lane,
            token,
            config.enabled,
            config.capacity,
            config.refillAmount,
            config.refillPeriod
        );
    }

    /// @notice What is spendable from a bucket right now.
    function remainingAllowance(
        uint64 lane,
        address token
    ) public view returns (uint256) {
        if (!limit[lane][token].enabled) return type(uint256).max;
        (uint256 available, ) = _settled(lane, token);
        return available;
    }

    /// @dev Apply refill accrued since the last update, without writing.
    ///      `lastRefillAt` advances only by the time the granted refill
    ///      actually accounts for, so frequent small consumptions do not
    ///      discard the remainder to integer division.
    function _settled(
        uint64 lane,
        address token
    ) internal view returns (uint256 available, uint256 lastRefillAt) {
        Limit memory config = limit[lane][token];
        Bucket memory bucket = buckets[lane][token];

        available = bucket.available;
        lastRefillAt = bucket.lastRefillAt;

        if (!config.enabled || config.refillAmount == 0 || config.refillPeriod == 0) {
            return (available, lastRefillAt);
        }

        uint256 elapsed = block.timestamp - lastRefillAt;
        uint256 refilled = (elapsed * config.refillAmount) / config.refillPeriod;
        if (refilled == 0) return (available, lastRefillAt);

        lastRefillAt += (refilled * config.refillPeriod) / config.refillAmount;
        available += refilled;

        if (available >= config.capacity) {
            available = config.capacity;
            lastRefillAt = block.timestamp;
        }
    }

    /// @dev Spend from a lane's bucket and from the aggregate bucket.
    function _consumeLimit(uint64 lane, address token, uint256 amount) internal {
        _consumeBucket(lane, token, amount);
        if (lane != ALL_LANES) _consumeBucket(ALL_LANES, token, amount);
    }

    function _consumeBucket(uint64 lane, address token, uint256 amount) private {
        if (!limit[lane][token].enabled) return;

        (uint256 available, uint256 lastRefillAt) = _settled(lane, token);
        if (amount > available) {
            revert RateLimitExceeded(lane, token, amount, available);
        }

        buckets[lane][token] = Bucket({
            available: available - amount,
            lastRefillAt: lastRefillAt
        });
    }
}
