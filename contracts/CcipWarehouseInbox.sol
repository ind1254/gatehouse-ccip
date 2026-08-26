// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

/// @title CcipWarehouseInbox
/// @notice Checkpoint 2: the destination warehouse's receiving desk.
/// @dev Inherits CCIPReceiver, so only the configured router may deliver.
///      It still trusts ANY source chain and ANY source warehouse, and it
///      still accepts the same messageId twice. Both are fixed in later
///      checkpoints.
contract CcipWarehouseInbox is CCIPReceiver {
    /// @notice CCIP's tracking number for the most recent delivery.
    bytes32 public lastMessageId;

    /// @notice Which chain the most recent delivery came from.
    uint64 public lastSourceChainSelector;

    /// @notice Which contract on that chain shipped it.
    address public lastSourceWarehouse;

    /// @notice The most recent delivery's contents.
    string public lastMessage;

    /// @notice How many deliveries have arrived.
    uint256 public deliveryCount;

    event DeliveryReceived(
        bytes32 indexed messageId,
        uint64 indexed sourceChainSelector,
        address indexed sourceWarehouse,
        string message
    );

    constructor(address router) CCIPReceiver(router) {}

    /// @dev Called by CCIPReceiver.ccipReceive, which enforces onlyRouter.
    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        address sourceWarehouse = abi.decode(message.sender, (address));
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
    }
}
