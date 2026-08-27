// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CcipWarehouseInbox
/// @notice The destination warehouse's receiving desk.
/// @dev Three gates stand between a delivery and our state:
///      1. `onlyRouter` (inherited): it arrived through CCIP at all.
///      2. The source allowlist: we trust that contract, on that chain.
///      3. The processed ledger: we have not handled this messageId before.
///      A delivery must clear all three. Cargo is credited only after they pass,
///      and because a revert unwinds the whole delivery, a refused message
///      leaves no tokens behind either.
contract CcipWarehouseInbox is CCIPReceiver, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Which (source chain, source warehouse) pairs we accept.
    /// @dev Keyed by the PAIR on purpose. Two independent allowlists - one of
    ///      chains, one of addresses - would accept a trusted address arriving
    ///      from the wrong chain. Addresses are not unique across chains.
    mapping(uint64 chainSelector => mapping(address warehouse => bool allowed))
        public allowedSourceWarehouse;

    /// @notice Every messageId we have already acted on.
    mapping(bytes32 messageId => bool processed) public processedMessages;

    /// @notice Everything we believe we have received, per token.
    /// @dev The accounting invariant: for any token this desk only receives and
    ///      the owner has not withdrawn, `totalReceived` equals the desk's
    ///      balance. Tests assert it; Checkpoint 6 will reconcile it on-chain
    ///      against the source desk's `totalShipped`.
    mapping(address token => uint256 total) public totalReceived;

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

    event SourceWarehouseSet(
        uint64 indexed sourceChainSelector,
        address indexed sourceWarehouse,
        bool allowed
    );

    /// @notice The delivery came from a chain/contract pair we do not trust.
    error SourceNotAllowed(uint64 sourceChainSelector, address sourceWarehouse);

    /// @notice This messageId has already been acted on.
    error MessageAlreadyProcessed(bytes32 messageId);

    constructor(address router) CCIPReceiver(router) Ownable(msg.sender) {}

    /// @notice Trust (or stop trusting) one warehouse on one chain.
    function setSourceWarehouse(
        uint64 sourceChainSelector,
        address sourceWarehouse,
        bool allowed
    ) external onlyOwner {
        allowedSourceWarehouse[sourceChainSelector][sourceWarehouse] = allowed;
        emit SourceWarehouseSet(sourceChainSelector, sourceWarehouse, allowed);
    }

    /// @notice Move received cargo out of the desk.
    /// @dev Without this the desk is a one-way door and the cargo is stranded.
    function withdrawCargo(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice How much of a token this desk is actually holding right now.
    /// @dev Compare with `totalReceived` to spot cargo that arrived without a
    ///      message, or a message credited without cargo.
    function cargoBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @dev Called by CCIPReceiver.ccipReceive, which enforces onlyRouter.
    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        address sourceWarehouse = abi.decode(message.sender, (address));

        // Gate 2: do we trust this sender, on this chain?
        if (!allowedSourceWarehouse[message.sourceChainSelector][sourceWarehouse]) {
            revert SourceNotAllowed(message.sourceChainSelector, sourceWarehouse);
        }

        // Gate 3: have we seen this exact delivery before?
        if (processedMessages[message.messageId]) {
            revert MessageAlreadyProcessed(message.messageId);
        }
        processedMessages[message.messageId] = true;

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

            totalReceived[token] += amount;
            lastCargoToken = token;
            lastCargoAmount = amount;

            emit CargoReceived(message.messageId, token, amount);
        }
    }
}
