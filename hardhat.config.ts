import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";

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
    // A node started with `npm run node`. Testnets arrive in Checkpoint 7.
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
    },
  },
});
