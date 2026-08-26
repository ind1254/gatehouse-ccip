// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title WarehouseOutbox
/// @notice Checkpoint 2: the source warehouse's shipping desk.
/// @dev Hands a message to the CCIP router and pays the fee in LINK.
///      Learning contract: no allowlists, limits, or pausing yet.
contract WarehouseOutbox {
    /// @notice The CCIP router on this chain (the loading dock).
    IRouterClient public immutable router;

    /// @notice The token used to pay CCIP fees.
    IERC20 public immutable feeToken;

    /// @notice Gas the destination contract is allowed to spend on arrival.
    uint256 public constant DESTINATION_GAS_LIMIT = 200_000;

    /// @notice Tracking numbers of every message this desk has shipped.
    bytes32[] public shippedMessageIds;

    event DeliveryShipped(
        bytes32 indexed messageId,
        uint64 indexed destinationChainSelector,
        address indexed receiver,
        string message,
        uint256 fee
    );

    error NotEnoughFeeTokenBalance(uint256 balance, uint256 required);

    constructor(address router_, address feeToken_) {
        router = IRouterClient(router_);
        feeToken = IERC20(feeToken_);
    }

    /// @notice Build the CCIP message this desk would ship.
    /// @dev Kept public so tests and the CLI can quote a fee without sending.
    function buildMessage(
        address receiver,
        string calldata message
    ) public pure returns (Client.EVM2AnyMessage memory) {
        return
            Client.EVM2AnyMessage({
                receiver: abi.encode(receiver),
                data: abi.encode(message),
                tokenAmounts: new Client.EVMTokenAmount[](0),
                extraArgs: Client._argsToBytes(
                    Client.GenericExtraArgsV2({
                        gasLimit: DESTINATION_GAS_LIMIT,
                        allowOutOfOrderExecution: true
                    })
                ),
                feeToken: address(0) // replaced in shipDelivery
            });
    }

    /// @notice What CCIP would charge to ship this message.
    function quoteDelivery(
        uint64 destinationChainSelector,
        address receiver,
        string calldata message
    ) public view returns (uint256 fee) {
        Client.EVM2AnyMessage memory evm2AnyMessage = buildMessage(receiver, message);
        evm2AnyMessage.feeToken = address(feeToken);
        return router.getFee(destinationChainSelector, evm2AnyMessage);
    }

    /// @notice Ship a text delivery to a warehouse on another chain.
    /// @dev Anyone can call this in Checkpoint 2. Access control comes later.
    function shipDelivery(
        uint64 destinationChainSelector,
        address receiver,
        string calldata message
    ) external returns (bytes32 messageId) {
        Client.EVM2AnyMessage memory evm2AnyMessage = buildMessage(receiver, message);
        evm2AnyMessage.feeToken = address(feeToken);

        uint256 fee = router.getFee(destinationChainSelector, evm2AnyMessage);
        uint256 balance = feeToken.balanceOf(address(this));
        if (balance < fee) revert NotEnoughFeeTokenBalance(balance, fee);

        feeToken.approve(address(router), fee);
        messageId = router.ccipSend(destinationChainSelector, evm2AnyMessage);

        shippedMessageIds.push(messageId);
        emit DeliveryShipped(messageId, destinationChainSelector, receiver, message, fee);
    }

    /// @notice How many messages this desk has shipped.
    function shippedCount() external view returns (uint256) {
        return shippedMessageIds.length;
    }
}
