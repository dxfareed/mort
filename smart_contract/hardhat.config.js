require("dotenv").config();
require("@nomicfoundation/hardhat-verify");
require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: "0.8.20",
  networks: {
    fuji: {
      url: process.env.ALCHEMY_FUJI_URL,
      chainId: 43113,
      accounts: [process.env.PRIVATE_KEY]
    }
  },
  sourcify: {
  enabled: true
  },
  etherscan: {
    apiKey: {
      fuji: "SNOWTRACE"   
    },
    customChains: [
      {
        network: "fuji",
        chainId: 43113,
        urls: {
          apiURL:  "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan",
          browserURL: "https://testnet.snowtrace.io"
        }
      }
    ]
  }
};
