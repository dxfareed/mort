require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const FlipGame = await hre.ethers.getContractFactory("FlipGame");
  const flip = await FlipGame.deploy(
    process.env.VRF_COORDINATOR,
    process.env.KEY_HASH,
    process.env.SUB_ID
  );

  const deployedContract = await flip.waitForDeployment();

  console.log("FlipGame deployed to:", await deployedContract.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
