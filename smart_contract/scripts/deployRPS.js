require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const RPSGame = await hre.ethers.getContractFactory("RPSGame");

  const game = await RPSGame.deploy(
    process.env.VRF_COORDINATOR,
    process.env.KEY_HASH,
    process.env.SUB_ID
  );

  const deployedContract = await game.waitForDeployment();

  console.log("RPSGame deployed to:", await deployedContract.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
