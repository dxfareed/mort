// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract FlipGame is VRFConsumerBaseV2Plus, ReentrancyGuard {
    bytes32 public immutable keyHash;
    uint256 public immutable subId;
    uint32 public callbackGasLimit;
    uint16 public constant REQUEST_CONFIRMATIONS = 3;
    uint32 public constant NUM_WORDS = 1;

    uint256 public minBet;
    uint256 public maxBet;
    uint256 public requestTimeout;
    //100000
    uint256 public constant PLAYER_PAYOUT_BPS = 19200;
    uint256 public constant HOUSE_FEE_BPS     = 500;
    uint256 public constant ADMIN_FEE_BPS     = 300;
    uint256 public constant BPS_DIVISOR       = 10000;

    uint256 public houseFees;
    uint256 public adminFees;
    uint256 public totalOutstandingBets;

    struct PlayerBet {
        address player;
        uint256 amount;
        uint8 choice;
        uint256 timestamp;
    }

    mapping(uint256 => PlayerBet) public requests;

    event FlipRequested(uint256 indexed requestId, address indexed player, uint256 amount, uint8 choice);
    event FlipResolved(uint256 indexed requestId, address indexed player, bool won, uint256 payout);
    event BetReclaimed(uint256 indexed requestId, address indexed player, uint256 amount);
    event AdminFeesWithdrawn(address indexed admin, uint256 amount);

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

    function setBetLimits(uint256 _minBet, uint256 _maxBet) external onlyOwner {
        require(_minBet > 0 && _minBet < _maxBet, "Invalid bet limits");
        minBet = _minBet;
        maxBet = _maxBet;
    }

    function setRequestTimeout(uint256 _timeout) external onlyOwner {
        requestTimeout = _timeout;
    }

    function setCallbackGasLimit(uint32 _newLimit) external onlyOwner {
        require(_newLimit >= 100_000 && _newLimit <= 1_000_000, "Gas limit out of bounds");
        callbackGasLimit = _newLimit;
    }

    function flip(uint8 _choice) external payable nonReentrant {
        require(_choice == 0 || _choice == 1, "Choice must be 0 or 1");
        require(msg.value >= minBet && msg.value <= maxBet, "Bet out of range");

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
        requests[requestId] = PlayerBet({
            player: msg.sender,
            amount: msg.value,
            choice: _choice,
            timestamp: block.timestamp
        });

        emit FlipRequested(requestId, msg.sender, msg.value, _choice);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        PlayerBet memory bet = requests[requestId];
        require(bet.player != address(0), "Unknown request");

        delete requests[requestId];
        totalOutstandingBets -= bet.amount;

        bool won = (uint8(randomWords[0] % 2) == bet.choice);
        uint256 payout = 0;

        uint256 totalFee = (bet.amount * (HOUSE_FEE_BPS + ADMIN_FEE_BPS)) / BPS_DIVISOR;
        uint256 housePortion = (bet.amount * HOUSE_FEE_BPS) / BPS_DIVISOR;
        uint256 adminPortion = totalFee - housePortion;

        houseFees += housePortion;
        adminFees += adminPortion;

        if (won) {
            payout = (bet.amount * PLAYER_PAYOUT_BPS) / BPS_DIVISOR;
            _safeTransfer(bet.player, payout);
        }

        emit FlipResolved(requestId, bet.player, won, payout);
    }

    function reclaimBet(uint256 requestId) external nonReentrant {
        PlayerBet memory bet = requests[requestId];
        require(bet.player == msg.sender, "Not your bet");
        require(block.timestamp > bet.timestamp + requestTimeout, "Too early to reclaim");

        delete requests[requestId];
        totalOutstandingBets -= bet.amount;

        _safeTransfer(msg.sender, bet.amount);
        emit BetReclaimed(requestId, msg.sender, bet.amount);
    }

    function withdrawAdminFees() external onlyOwner nonReentrant {
        uint256 amt = adminFees;
        require(amt > 0, "No fees available");
        adminFees = 0;
        _safeTransfer(owner(), amt);
        emit AdminFeesWithdrawn(owner(), amt);
    }

    function getHouseBalance() external view returns (uint256) {
        return (address(this).balance - adminFees) - totalOutstandingBets;
    }

    function _safeTransfer(address to, uint256 amount) internal {
        (bool sent, ) = to.call{ value: amount }("");
        require(sent, "Transfer failed");
    }

    receive() external payable {}
    fallback() external payable {}
}