// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {WarehouseControls} from "./WarehouseControls.sol";

/// @title WarehouseOutbox
/// @notice The source warehouse's shipping desk.
/// @dev Gates in front of every shipment:
///      1. The caller must be an authorised shipper.
///      2. The (destination chain, receiver) pair must be allowlisted.
///      3. Cargo shipments must use an allowlisted token.
///      The desk pays CCIP fees from its own LINK balance, and ships cargo from
///      its own token balance, so shippers hold neither.
contract WarehouseOutbox is WarehouseControls {
    using SafeERC20 for IERC20;

    /// @notice The CCIP router on this chain (the loading dock).
    IRouterClient public immutable router;

    /// @notice The token used to pay CCIP fees.
    IERC20 public immutable feeToken;

    /// @notice Gas the destination contract is allowed to spend on arrival.
    /// @dev Deliberately a variable, not a constant. Every gate added to the
    ///      inbox costs destination gas, and a message whose gasLimit is too
    ///      small fails ON ARRIVAL - after the fee is paid - and needs manual
    ///      re-execution. This has to be re-tuned whenever the receiver grows.
    uint256 public destinationGasLimit = 600_000;

    /// @notice Who may ship from this desk.
    mapping(address account => bool allowed) public isShipper;

    /// @notice Which (destination chain, receiving desk) pairs we ship to.
    mapping(uint64 chainSelector => mapping(address receiver => bool allowed))
        public allowedDestination;

    /// @notice Which tokens this desk is allowed to send as cargo.
    mapping(address token => bool allowed) public allowedToken;

    /// @notice Running total of cargo this desk has sent, per token.
    mapping(address token => uint256 total) public totalShipped;

    /// @notice Tracking numbers of every message this desk has shipped.
    bytes32[] public shippedMessageIds;

    event DeliveryShipped(
        bytes32 indexed messageId,
        uint64 indexed destinationChainSelector,
        address indexed receiver,
        string message,
        uint256 fee
    );

    event CargoShipped(
        bytes32 indexed messageId,
        address indexed token,
        uint256 amount
    );

    event ShipperSet(address indexed account, bool allowed);

    event DestinationSet(
        uint64 indexed destinationChainSelector,
        address indexed receiver,
        bool allowed
    );

    event TokenSet(address indexed token, bool allowed);

    event DestinationGasLimitSet(uint256 gasLimit);

    error NotEnoughFeeTokenBalance(uint256 balance, uint256 required);
    error NotEnoughCargo(address token, uint256 balance, uint256 required);
    error NotAShipper(address caller);
    error DestinationNotAllowed(uint64 destinationChainSelector, address receiver);
    error TokenNotAllowed(address token);
    error ZeroCargoAmount();

    modifier onlyShipper() {
        if (!isShipper[msg.sender]) revert NotAShipper(msg.sender);
        _;
    }

    constructor(address router_, address feeToken_) WarehouseControls(msg.sender) {
        router = IRouterClient(router_);
        feeToken = IERC20(feeToken_);
    }

    // ----------------------------------------------------------------- admin

    /// @notice Allow (or stop allowing) an account to ship from this desk.
    function setShipper(address account, bool allowed) external onlyRole(CONFIG_ROLE) {
        _requireDelayIfWidening(allowed);
        isShipper[account] = allowed;
        emit ShipperSet(account, allowed);
    }

    /// @notice Allow (or stop allowing) one receiving desk on one chain.
    function setDestination(
        uint64 destinationChainSelector,
        address receiver,
        bool allowed
    ) external onlyRole(CONFIG_ROLE) {
        _requireDelayIfWidening(allowed);
        allowedDestination[destinationChainSelector][receiver] = allowed;
        emit DestinationSet(destinationChainSelector, receiver, allowed);
    }

    /// @notice Set how much gas the destination desk may spend on arrival.
    function setDestinationGasLimit(uint256 newGasLimit) external onlyRole(CONFIG_ROLE) {
        destinationGasLimit = newGasLimit;
        emit DestinationGasLimitSet(newGasLimit);
    }

    /// @notice Allow (or stop allowing) a token to be shipped as cargo.
    function setToken(address token, bool allowed) external onlyRole(CONFIG_ROLE) {
        _requireDelayIfWidening(allowed);
        allowedToken[token] = allowed;
        emit TokenSet(token, allowed);
    }

    // --------------------------------------------------------------- quoting

    /// @notice Build a message that carries only text.
    function buildMessage(
        address receiver,
        string calldata message
    ) public view returns (Client.EVM2AnyMessage memory) {
        return _buildMessage(receiver, message, new Client.EVMTokenAmount[](0));
    }

    /// @notice Build a message that carries text and one token.
    function buildCargoMessage(
        address receiver,
        string calldata message,
        address token,
        uint256 amount
    ) public view returns (Client.EVM2AnyMessage memory) {
        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](1);
        tokenAmounts[0] = Client.EVMTokenAmount({token: token, amount: amount});
        return _buildMessage(receiver, message, tokenAmounts);
    }

    /// @notice What CCIP would charge to ship a text-only message.
    function quoteDelivery(
        uint64 destinationChainSelector,
        address receiver,
        string calldata message
    ) public view returns (uint256 fee) {
        Client.EVM2AnyMessage memory evm2AnyMessage = buildMessage(receiver, message);
        evm2AnyMessage.feeToken = address(feeToken);
        return router.getFee(destinationChainSelector, evm2AnyMessage);
    }

    // -------------------------------------------------------------- shipping

    /// @notice Ship a text delivery to a warehouse on another chain.
    function shipDelivery(
        uint64 destinationChainSelector,
        address receiver,
        string calldata message
    ) external onlyShipper returns (bytes32 messageId) {
        Client.EVM2AnyMessage memory evm2AnyMessage = buildMessage(receiver, message);
        return _ship(destinationChainSelector, receiver, evm2AnyMessage, message);
    }

    /// @notice Ship tokens, with a text note, to a warehouse on another chain.
    /// @dev The cargo leaves this contract balance. The desk must hold it.
    function shipCargo(
        uint64 destinationChainSelector,
        address receiver,
        address token,
        uint256 amount,
        string calldata message
    ) external onlyShipper returns (bytes32 messageId) {
        if (amount == 0) revert ZeroCargoAmount();
        if (!allowedToken[token]) revert TokenNotAllowed(token);

        uint256 cargoBalance = IERC20(token).balanceOf(address(this));
        if (cargoBalance < amount) {
            revert NotEnoughCargo(token, cargoBalance, amount);
        }

        Client.EVM2AnyMessage memory evm2AnyMessage = buildCargoMessage(
            receiver,
            message,
            token,
            amount
        );

        // Gate 4: does this fit the budget for this lane and token? Applies to
        // every shipper, including a compromised one.
        _consumeLimit(destinationChainSelector, token, amount);

        // The router pulls the cargo from this contract, exactly as it pulls
        // the fee. forceApprove clears any stale allowance first.
        IERC20(token).forceApprove(address(router), amount);

        messageId = _ship(destinationChainSelector, receiver, evm2AnyMessage, message);

        totalShipped[token] += amount;
        emit CargoShipped(messageId, token, amount);
    }

    /// @dev Shared send path: check the destination, pay, send, record.
    function _ship(
        uint64 destinationChainSelector,
        address receiver,
        Client.EVM2AnyMessage memory evm2AnyMessage,
        string calldata message
    ) internal whenNotPaused returns (bytes32 messageId) {
        if (!allowedDestination[destinationChainSelector][receiver]) {
            revert DestinationNotAllowed(destinationChainSelector, receiver);
        }

        // Every shipment costs one from the delivery-count budget. This is what
        // bounds a flood of individually-valid messages.
        _consumeLimit(destinationChainSelector, MESSAGE_COUNT_BUCKET, 1);

        evm2AnyMessage.feeToken = address(feeToken);

        uint256 fee = router.getFee(destinationChainSelector, evm2AnyMessage);
        uint256 balance = feeToken.balanceOf(address(this));
        if (balance < fee) revert NotEnoughFeeTokenBalance(balance, fee);

        feeToken.forceApprove(address(router), fee);
        messageId = router.ccipSend(destinationChainSelector, evm2AnyMessage);

        shippedMessageIds.push(messageId);
        emit DeliveryShipped(messageId, destinationChainSelector, receiver, message, fee);
    }

    /// @notice How many messages this desk has shipped.
    function shippedCount() external view returns (uint256) {
        return shippedMessageIds.length;
    }

    // -------------------------------------------------------------- treasury

    /// @notice Recover tokens held by this desk.
    function withdraw(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(TREASURY_ROLE) {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @dev Build the CCIP message struct.
    function _buildMessage(
        address receiver,
        string memory message,
        Client.EVMTokenAmount[] memory tokenAmounts
    ) internal view returns (Client.EVM2AnyMessage memory) {
        return
            Client.EVM2AnyMessage({
                receiver: abi.encode(receiver),
                data: abi.encode(message),
                tokenAmounts: tokenAmounts,
                extraArgs: Client._argsToBytes(
                    Client.GenericExtraArgsV2({
                        gasLimit: destinationGasLimit,
                        allowOutOfOrderExecution: true
                    })
                ),
                feeToken: address(0) // replaced in _ship
            });
    }
}
