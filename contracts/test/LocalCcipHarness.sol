// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";

/// @title LocalCcipNetwork
/// @notice Test-only wrapper so Hardhat produces an artifact for Chainlink's
///         local CCIP simulator. It plays the part of the whole CCIP network:
///         both routers, the LINK token, and the delivery itself.
/// @dev Never deployed to a real network.
contract LocalCcipNetwork is CCIPLocalSimulator {}
