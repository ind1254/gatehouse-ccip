// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title WarehouseInbox
/// @notice Checkpoint 1: the smallest possible destination "warehouse".
/// @dev This is a learning contract, not production-ready code.
contract WarehouseInbox {
    string public lastMessage;
    address public lastCourier;
    uint256 public deliveryCount;

    event DeliveryReceived(
        uint256 indexed deliveryNumber,
        address indexed courier,
        string message
    );

    /// @notice Store a new delivery message.
    /// @dev Anyone can call this in Checkpoint 1. We will secure it later.
    function receiveDelivery(string calldata message) external {
        lastMessage = message;
        lastCourier = msg.sender;
        deliveryCount += 1;

        emit DeliveryReceived(deliveryCount, msg.sender, message);
    }
}
