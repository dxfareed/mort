const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("FlipGame", function () {
  let flipGame, owner, alice;

  const MIN_BET = ethers.parseEther("0.0001");
  const BET = ethers.parseEther("0.2");
  const TIMEOUT = 15 * 60;

  beforeEach(async () => {
    [owner, alice] = await ethers.getSigners();
    const FlipGameFactory = await ethers.getContractFactory("FlipGame");
    
    flipGame = await FlipGameFactory.deploy(owner.address, ethers.ZeroHash, 0);
    
    await flipGame.waitForDeployment();
  });

  it("flip() rejects bad bets", async () => {
    await expect(flipGame.connect(alice).flip(2, { value: MIN_BET }))
      .to.be.revertedWith("Choice must be 0 or 1");

    await expect(flipGame.connect(alice).flip(1, { value: MIN_BET / 2n }))
      .to.be.revertedWith("Bet out of range");
  });

  it("flip() emits and tracks", async () => {
    await expect(flipGame.connect(alice).flip(1, { value: BET }))
      .to.emit(flipGame, "FlipRequested")
      .withArgs(anyValue, alice.address, BET, 1);
      
    expect(await flipGame.totalOutstandingBets()).to.equal(BET);
  });

  it("reclaimBet() after timeout", async () => {
    const tx = await flipGame.connect(alice).flip(0, { value: BET });
    const receipt = await tx.wait();
    const logs = receipt.getLogs(flipGame.filters.FlipRequested());
    const { requestId } = logs[0].args;
    
    await network.provider.send("evm_increaseTime", [TIMEOUT + 1]);
    await network.provider.send("evm_mine");

    await expect(flipGame.connect(alice).reclaimBet(requestId))
      .to.emit(flipGame, "BetReclaimed")
      .withArgs(requestId, alice.address, BET);
  });
});