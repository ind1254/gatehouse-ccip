// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {WarehouseControls} from "./WarehouseControls.sol";

/// @title CcipWarehouseInbox
/// @notice The destination warehouse's receiving desk.
/// @dev Gates between a delivery and settled state:
///      1. `onlyRouter` (inherited): it arrived through CCIP at all.
///      2. Not paused: we are accepting deliveries right now.
///      3. The source allowlist: we trust that contract, on that chain.
///      4. The processed ledger: we have not handled this messageId before.
///      5. The rate limit: it fits in the current window's budget.
///      Cargo at or above the large-transfer threshold then waits out a delay
///      before it counts as settled, giving operators a window to react.
contract CcipWarehouseInbox is CCIPReceiver, WarehouseControls {
    using SafeERC20 for IERC20;

    /// @notice Cargo that has arrived but is not yet settled.
    struct HeldCargo {
        address token;
        uint256 amount;
        uint256 releasableAt;
        bool released;
    }

    /// @notice Which (source chain, source warehouse) pairs we accept.
    /// @dev Keyed by the PAIR on purpose. Two independent allowlists - one of
    ///      chains, one of addresses - would accept a trusted address arriving
    ///      from the wrong chain. Addresses are not unique across chains.
    mapping(uint64 chainSelector => mapping(address warehouse => bool allowed))
        public allowedSourceWarehouse;

    /// @notice Every messageId we have already acted on.
    mapping(bytes32 messageId => bool processed) public processedMessages;

    /// @notice Settled cargo, per token.
    mapping(address token => uint256 total) public totalReceived;

    /// @notice Cargo sitting out its delay, per token. Not withdrawable.
    mapping(address token => uint256 total) public totalHeld;

    /// @notice Deliveries whose cargo is waiting on the delay, by messageId.
    mapping(bytes32 messageId => HeldCargo) public heldCargo;

    /// @notice At or above this amount, cargo is held rather than settled.
    /// @dev Zero disables the hold for that token.
    mapping(address token => uint256 threshold) public largeTransferThreshold;

    /// @notice How long held cargo must wait before it can be released.
    uint256 public releaseDelay;

    bytes32 public lastMessageId;
    uint64 public lastSourceChainSelector;
    address public lastSourceWarehouse;
    string public lastMessage;
    uint256 public deliveryCount;

    address public lastCargoToken;
    uint256 public lastCargoAmount;

    event DeliveryReceived(
        bytes32 indexed messageId,
        uint64 indexed sourceChainSelector,
        address indexed sourceWarehouse,
        string message
    );

    event CargoReceived(
        bytes32 indexed messageId,
        address indexed token,
        uint256 amount
    );

    event CargoHeld(
        bytes32 indexed messageId,
        address indexed token,
        uint256 amount,
        uint256 releasableAt
    );

    event CargoReleased(
        bytes32 indexed messageId,
        address indexed token,
        uint256 amount
    );

    event SourceWarehouseSet(
        uint64 indexed sourceChainSelector,
        address indexed sourceWarehouse,
        bool allowed
    );

    event LargeTransferThresholdSet(address indexed token, uint256 threshold);
    event ReleaseDelaySet(uint256 releaseDelay);

    /// @notice The delivery came from a chain/contract pair we do not trust.
    error SourceNotAllowed(uint64 sourceChainSelector, address sourceWarehouse);

    /// @notice This messageId has already been acted on.
    error MessageAlreadyProcessed(bytes32 messageId);

    /// @notice No cargo is being held under this messageId.
    error NothingHeld(bytes32 messageId);

    /// @notice The hold has not expired yet.
    error StillHeld(bytes32 messageId, uint256 releasableAt);

    /// @notice That cargo has already been released.
    error AlreadyReleased(bytes32 messageId);

    /// @notice Held cargo is not withdrawable, so the desk cannot cover this.
    error CargoNotSettled(address token, uint256 withdrawable, uint256 requested);

    constructor(address router) CCIPReceiver(router) WarehouseControls(msg.sender) {}

    // ------------------------------------------------------------------ admin

    /// @notice Trust (or stop trusting) one warehouse on one chain.
    function setSourceWarehouse(
        uint64 sourceChainSelector,
        address sourceWarehouse,
        bool allowed
    ) external onlyOwner {
        allowedSourceWarehouse[sourceChainSelector][sourceWarehouse] = allowed;
        emit SourceWarehouseSet(sourceChainSelector, sourceWarehouse, allowed);
    }

    /// @notice Set the amount at or above which cargo waits out the delay.
    function setLargeTransferThreshold(
        address token,
        uint256 threshold
    ) external onlyOwner {
        largeTransferThreshold[token] = threshold;
        emit LargeTransferThresholdSet(token, threshold);
    }

    /// @notice Set how long held cargo waits.
    function setReleaseDelay(uint256 newReleaseDelay) external onlyOwner {
        releaseDelay = newReleaseDelay;
        emit ReleaseDelaySet(newReleaseDelay);
    }

    // ---------------------------------------------------------------- release

    /// @notice Settle cargo whose hold has expired.
    /// @dev Deliberately callable by anyone: releasing is not a privilege, it is
    ///      the passage of time. But it is blocked while paused, so an incident
    ///      freezes everything mid-flight instead of letting holds mature.
    function releaseCargo(bytes32 messageId) external whenNotPaused {
        HeldCargo storage held = heldCargo[messageId];

        if (held.amount == 0) revert NothingHeld(messageId);
        if (held.released) revert AlreadyReleased(messageId);
        if (block.timestamp < held.releasableAt) {
            revert StillHeld(messageId, held.releasableAt);
        }

        held.released = true;
        totalHeld[held.token] -= held.amount;
        totalReceived[held.token] += held.amount;

        emit CargoReleased(messageId, held.token, held.amount);
    }

    // --------------------------------------------------------------- treasury

    /// @notice Cargo the owner may actually move: everything except held cargo.
    function withdrawableCargo(address token) public view returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 held = totalHeld[token];
        return balance > held ? balance - held : 0;
    }

    /// @notice Move settled cargo out of the desk.
    /// @dev Held cargo is deducted first, so the delay cannot be side-stepped
    ///      by withdrawing the tokens it is guarding.
    function withdrawCargo(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        uint256 withdrawable = withdrawableCargo(token);
        if (amount > withdrawable) {
            revert CargoNotSettled(token, withdrawable, amount);
        }
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice How much of a token this desk is actually holding right now.
    /// @dev Compare with `totalReceived` to spot cargo that arrived without a
    ///      message, or a message credited without cargo.
    function cargoBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    // ---------------------------------------------------------------- receive

    /// @dev Called by CCIPReceiver.ccipReceive, which enforces onlyRouter.
    function _ccipReceive(
        Client.Any2EVMMessage memory message
    ) internal override whenNotPaused {
        address sourceWarehouse = abi.decode(message.sender, (address));

        // Gate 3: do we trust this sender, on this chain?
        if (!allowedSourceWarehouse[message.sourceChainSelector][sourceWarehouse]) {
            revert SourceNotAllowed(message.sourceChainSelector, sourceWarehouse);
        }

        // Gate 4: have we seen this exact delivery before?
        if (processedMessages[message.messageId]) {
            revert MessageAlreadyProcessed(message.messageId);
        }
        processedMessages[message.messageId] = true;

        // Gate 5: does this fit in the current window's delivery budget?
        _consumeLimit(MESSAGE_COUNT_BUCKET, 1);

        string memory text = abi.decode(message.data, (string));

        lastMessageId = message.messageId;
        lastSourceChainSelector = message.sourceChainSelector;
        lastSourceWarehouse = sourceWarehouse;
        lastMessage = text;
        deliveryCount += 1;

        emit DeliveryReceived(
            message.messageId,
            message.sourceChainSelector,
            sourceWarehouse,
            text
        );

        // CCIP moves the tokens to this address as part of executing the
        // message. We only record what arrived; we never move it ourselves.
        uint256 cargoCount = message.destTokenAmounts.length;
        for (uint256 i = 0; i < cargoCount; ++i) {
            address token = message.destTokenAmounts[i].token;
            uint256 amount = message.destTokenAmounts[i].amount;

            _consumeLimit(token, amount);

            lastCargoToken = token;
            lastCargoAmount = amount;
            emit CargoReceived(message.messageId, token, amount);

            uint256 threshold = largeTransferThreshold[token];
            if (threshold != 0 && amount >= threshold) {
                heldCargo[message.messageId] = HeldCargo({
                    token: token,
                    amount: amount,
                    releasableAt: block.timestamp + releaseDelay,
                    released: false
                });
                totalHeld[token] += amount;

                emit CargoHeld(
                    message.messageId,
                    token,
                    amount,
                    block.timestamp + releaseDelay
                );
            } else {
                totalReceived[token] += amount;
            }
        }
    }
}
