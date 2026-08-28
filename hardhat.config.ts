import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

/**
 * Secrets are read from Hardhat's encrypted keystore, never from this file and
 * never from a committed .env.
 *
 *   npx hardhat keystore set SEPOLIA_RPC_URL
 *   npx hardhat keystore set BASE_SEPOLIA_RPC_URL
 *   npx hardhat keystore set DEPLOYER_PRIVATE_KEY
 *
 * `configVariable` resolves at use time, so tasks that never touch a testnet
 * never prompt for the password.
 */
export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // A node started with `npm run node`.
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      type: "http",
      chainId: 11155111,
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    baseSepolia: {
      type: "http",
      chainId: 84532,
      url: configVariable("BASE_SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
});
