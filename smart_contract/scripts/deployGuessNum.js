require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const LuckyNumberGame = await hre.ethers.getContractFactory("LuckyNumberGame");

  const game = await LuckyNumberGame.deploy(
    process.env.VRF_COORDINATOR,
    process.env.KEY_HASH,
    process.env.SUB_ID
  );

  const deployedContract = await game.waitForDeployment();

  console.log("LuckyNumberGame deployed to:", await deployedContract.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
