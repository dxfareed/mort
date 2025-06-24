// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract RPSGame is VRFConsumerBaseV2Plus, ReentrancyGuard {
    enum Choice { Rock, Paper, Scissor }
    enum Outcome { PlayerWins, ComputerWins, Draw }

    bytes32 public immutable keyHash;
    uint256 public immutable subId;
    uint32 public callbackGasLimit;
    uint16 public constant REQUEST_CONFIRMATIONS = 3;
    uint32 public constant NUM_WORDS = 1;

    uint256 public minBet;
    uint256 public maxBet;
    uint256 public requestTimeout;

    uint256 public constant PLAYER_PAYOUT_BPS = 19200;
    uint256 public constant HOUSE_FEE_BPS = 500;
    uint256 public constant ADMIN_FEE_BPS = 300;
    uint256 public constant BPS_DIVISOR = 10000;

    uint256 public houseFees;
    uint256 public adminFees;
    uint256 public totalOutstandingBets;

    struct Player {
        address playerAddress;
        Choice choice;
        uint256 betAmount;
        uint256 blockTimestamp;
    }

    mapping(uint256 => Player) public requestToPlayer;

    event GamePlayed(uint256 indexed requestId, address indexed player, uint256 betAmount, Choice choice);
    event GameResult(uint256 indexed requestId, address indexed player, Outcome outcome, Choice playerChoice, Choice computerChoice, uint256 prizeAmount);
    event BetReclaimed(uint256 indexed requestId, address indexed player, uint256 betAmount);
    event FeesWithdrawn(address indexed admin, uint256 amount);
    event HouseFundsWithdrawn(address indexed admin, uint256 amount);
    event BetLimitsUpdated(uint256 minBet, uint256 maxBet);
    event RequestTimeoutUpdated(uint256 timeout);
    event CallbackGasLimitUpdated(uint32 newGasLimit);
    event FallbackReceived(address indexed sender, uint256 amount);
   
    //100000 gwei //0.0001 eth
    //5000000 gwei //0.005 eth

    constructor(
        address vrfCoordinator,
        bytes32 _keyHash,
        uint256 _subId
    ) VRFConsumerBaseV2Plus(vrfCoordinator) {
        keyHash = _keyHash;
        subId = _subId;
        callbackGasLimit = 200_000;
        minBet = 0.0001 ether;
        maxBet = 1 ether;
        requestTimeout = 15 minutes;
    }

    function play(Choice _choice) external payable nonReentrant {
        require(uint8(_choice) <= 2, "Choice must be 0, 1, or 2");
        require(msg.value >= minBet, "Bet is below the minimum");
        require(msg.value <= maxBet, "Bet is above the maximum");
        totalOutstandingBets += msg.value;

        VRFV2PlusClient.RandomWordsRequest memory req = VRFV2PlusClient.RandomWordsRequest({
            keyHash: keyHash,
            subId: subId,
            requestConfirmations: REQUEST_CONFIRMATIONS,
            callbackGasLimit: callbackGasLimit,
            numWords: NUM_WORDS,
            extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({ nativePayment: false }))
        });

        uint256 requestId = s_vrfCoordinator.requestRandomWords(req);

        requestToPlayer[requestId] = Player({
            playerAddress: msg.sender,
            choice: _choice,
            betAmount: msg.value,
            blockTimestamp: block.timestamp
        });

        emit GamePlayed(requestId, msg.sender, msg.value, _choice);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        Player memory playerInfo = requestToPlayer[requestId];
        require(playerInfo.playerAddress != address(0), "Request ID not found");

        delete requestToPlayer[requestId];
        totalOutstandingBets -= playerInfo.betAmount;

        Choice computerChoice = Choice(randomWords[0] % 3);
        Outcome gameOutcome = _getOutcome(playerInfo.choice, computerChoice);
        uint256 betAmount = playerInfo.betAmount;
        uint256 prizeAmount;

        if (gameOutcome != Outcome.Draw) {
            uint256 totalFee = (betAmount * (HOUSE_FEE_BPS + ADMIN_FEE_BPS)) / BPS_DIVISOR;
            uint256 housePortion = (betAmount * HOUSE_FEE_BPS) / BPS_DIVISOR;
            uint256 adminPortion = totalFee - housePortion;
            houseFees += housePortion;
            adminFees += adminPortion;
        }

        if (gameOutcome == Outcome.PlayerWins) {
            prizeAmount = (betAmount * PLAYER_PAYOUT_BPS) / BPS_DIVISOR;
            _safeTransfer(playerInfo.playerAddress, prizeAmount);
        } else if (gameOutcome == Outcome.Draw) {
            prizeAmount = betAmount;
            _safeTransfer(playerInfo.playerAddress, prizeAmount);
        }

        emit GameResult(requestId, playerInfo.playerAddress, gameOutcome, playerInfo.choice, computerChoice, prizeAmount);
    }

    function reclaimBet(uint256 requestId) external nonReentrant {
        Player memory playerInfo = requestToPlayer[requestId];
        require(playerInfo.playerAddress == msg.sender, "Not your request");
        require(block.timestamp > playerInfo.blockTimestamp + requestTimeout, "Timeout not yet reached");

        delete requestToPlayer[requestId];
        totalOutstandingBets -= playerInfo.betAmount;

        _safeTransfer(msg.sender, playerInfo.betAmount);
        emit BetReclaimed(requestId, msg.sender, playerInfo.betAmount);
    }

    function getHouseBalance() public view returns (uint256) {
        return address(this).balance - adminFees - totalOutstandingBets;
    }

    function getAdminFeeBalance() external view returns (uint256) {
        return adminFees;
    }

    function withdrawAdminFees() external nonReentrant onlyOwner {
        uint256 amount = adminFees;
        require(amount > 0, "No fees to withdraw");
        adminFees = 0;
        _safeTransfer(owner(), amount);
        emit FeesWithdrawn(owner(), amount);
    }

    function withdrawHouseFunds(uint256 amount) external nonReentrant onlyOwner {
        require(amount <= getHouseBalance(), "Exceeds house funds");
        _safeTransfer(owner(), amount);
        emit HouseFundsWithdrawn(owner(), amount);
    }

    function setBetLimits(uint256 _minBet, uint256 _maxBet) external onlyOwner {
        require(_minBet > 0 && _minBet < _maxBet, "Invalid bet limits");
        minBet = _minBet;
        maxBet = _maxBet;
        emit BetLimitsUpdated(_minBet, _maxBet);
    }

    function setRequestTimeout(uint256 _timeout) external onlyOwner {
        requestTimeout = _timeout;
        emit RequestTimeoutUpdated(_timeout);
    }

    function setCallbackGasLimit(uint32 _newLimit) external onlyOwner {
        require(_newLimit >= 100_000 && _newLimit <= 1_000_000, "Gas limit out of bounds");
        callbackGasLimit = _newLimit;
        emit CallbackGasLimitUpdated(_newLimit);
    }

    function _getOutcome(Choice _player, Choice _comp) internal pure returns (Outcome) {
        if (_player == _comp) return Outcome.Draw;
        if ((_player == Choice.Rock && _comp == Choice.Scissor) ||
            (_player == Choice.Paper && _comp == Choice.Rock) ||
            (_player == Choice.Scissor && _comp == Choice.Paper)) {
            return Outcome.PlayerWins;
        }
        return Outcome.ComputerWins;
    }

    function _safeTransfer(address to, uint256 amount) internal {
        (bool sent,) = to.call{ value: amount }("");
        require(sent, "Transfer failed");
    }


    //helper function.. will remove on production
    function withdraw() external {
        require(msg.sender == owner(), "Only admin");
        uint256 bal = address(this).balance;
        (bool sent, ) = owner().call{value: bal}("");
        require(sent, "Withdrawal failed");
    }

    receive() external payable {}
    fallback() external payable {
        emit FallbackReceived(msg.sender, msg.value);
    }
}
