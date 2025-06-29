// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/*
    Lucky Number Game with Chainlink VRF
    Player receives 5 random numbers and must guess the lucky winning number
    Winning players receive 4.8x their bet amount
    Uses Chainlink VRF for verifiable random number generation
*/

contract LuckyNumberGame is VRFConsumerBaseV2Plus, ReentrancyGuard {
    enum GameStatus { Pending, Ready }
    enum Outcome { PlayerWins, PlayerLoses }

    struct Game {
        address player;
        uint256 bet;
        uint256 ts;
    }
    
    struct GameData {
        uint8[5] numbers;
        uint8 winningIndex;
    }

    address public immutable vrfCoordinator;
    bytes32 public immutable keyHash;
    uint256 public immutable subId;
    uint32 public callbackGasLimit;
    uint16 public constant REQUEST_CONFIRMATIONS = 3;
    uint32 public constant NUM_WORDS = 6;

    uint256 public minBet;
    uint256 public maxBet;
    uint256 public requestTimeout;

    uint256 public houseFees;
    uint256 public adminFees;
    uint256 public totalOutstandingBets;

    uint256 public constant PLAYER_PAYOUT_BPS = 48000;
    uint256 public constant HOUSE_FEE_BPS   = 1200;
    uint256 public constant ADMIN_FEE_BPS   = 800;
    uint256 public constant BPS_DIVISOR     = 10000;

    uint8 public constant MIN_DRAW = 11;
    uint8 public constant MAX_DRAW = 99;
    uint256 public constant DRAW_RANGE = MAX_DRAW - MIN_DRAW + 1;

    mapping(uint256 => Game)     public games;
    mapping(uint256 => GameData) private results;

    event GameStarted(uint256 indexed id, address indexed player, uint256 bet);
    event GameReady(uint256 indexed id, uint8[5] numbers);
    event GameResult(uint256 indexed id, address indexed player, Outcome outcome, uint8 guessIndex, uint8 winningIndex, uint256 prize);
    event BetReclaimed(uint256 indexed id, address indexed player, uint256 bet);
    event FeesWithdrawn(address indexed to, uint256 amount);

    constructor(
        address _vrfCoordinator,
        bytes32 _keyHash,
        uint256 _subId
    ) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        vrfCoordinator = _vrfCoordinator;
        keyHash        = _keyHash;
        subId          = _subId;
        callbackGasLimit = 300_000;
        minBet         = 0.0001 ether;
        maxBet         = 0.5 ether;
        requestTimeout = 15 minutes;
    }

    function play() external payable nonReentrant {
        require(msg.value >= minBet && msg.value <= maxBet, "Bet out of range");
        totalOutstandingBets += msg.value;

        uint256 id = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit: callbackGasLimit,
                numWords: NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({ nativePayment: false }))
            })
        );
        games[id] = Game({ player: msg.sender, bet: msg.value, ts: block.timestamp });
        emit GameStarted(id, msg.sender, msg.value);
    }

    function fulfillRandomWords(uint256 id, uint256[] calldata rands) internal override {
        Game storage g = games[id];
        require(g.player != address(0), "Unknown game");

        uint8[5] memory nums;
        for (uint i = 0; i < 5; ) {
            nums[i] = uint8((rands[i] % DRAW_RANGE) + MIN_DRAW);
            unchecked { i++; }
        }
        
        uint8 winIndex = uint8(rands[5] % 5);
        
        results[id] = GameData({ numbers: nums, winningIndex: winIndex });
        emit GameReady(id, nums);
    }

    function makeGuess(uint256 id, uint8 guessIndex) external nonReentrant {
        Game memory g = games[id];
        require(g.player == msg.sender, "Not your game");
        require(guessIndex < 5, "Guess index must be 0-4");
        
        GameData memory res = results[id];
        require(res.numbers[0] != 0, "Game not ready");

        bool won = (guessIndex == res.winningIndex);
        uint256 pot = g.bet * 5;
        
        if (won) {
            uint256 payout = (pot * PLAYER_PAYOUT_BPS) / BPS_DIVISOR;
            uint256 houseCut = (pot * HOUSE_FEE_BPS) / BPS_DIVISOR;
            uint256 adminCut = (pot * ADMIN_FEE_BPS) / BPS_DIVISOR;
            
            houseFees += houseCut;
            adminFees += adminCut;
            
            _safeTransfer(g.player, payout);
            emit GameResult(id, g.player, Outcome.PlayerWins, guessIndex, res.winningIndex, payout);
        } else {
            houseFees += g.bet;
            emit GameResult(id, g.player, Outcome.PlayerLoses, guessIndex, res.winningIndex, 0);
        }

        totalOutstandingBets -= g.bet;
        delete games[id];
        delete results[id];
    }

    function _safeTransfer(address to, uint256 amt) internal {
        (bool ok, ) = to.call{ value: amt }("");
        require(ok, "Transfer failed");
    }

    function reclaimBet(uint256 id) external nonReentrant {
        Game storage g = games[id];
        require(g.player == msg.sender, "Not your game");
        require(block.timestamp > g.ts + requestTimeout, "Too early");
        totalOutstandingBets -= g.bet;
        uint256 amt = g.bet;
        delete games[id];
        _safeTransfer(msg.sender, amt);
        emit BetReclaimed(id, msg.sender, amt);
    }
    function withdrawAdminFees() external nonReentrant onlyOwner {
        uint256 amt = adminFees;
        require(amt > 0, "No admin fees");
        adminFees = 0;
        _safeTransfer(owner(), amt);
        emit FeesWithdrawn(owner(), amt);
    }
    function withdrawHouseFees() external nonReentrant onlyOwner {
        uint256 amt = houseFees;
        require(amt > 0, "No house fees");
        houseFees = 0;
        _safeTransfer(owner(), amt);
        emit FeesWithdrawn(owner(), amt);
    }
    function setBetLimits(uint256 min_, uint256 max_) external nonReentrant onlyOwner {
        require(min_ > 0 && min_ < max_, "Invalid limits");
        minBet = min_;
        maxBet = max_;
    }
    receive() external payable {}
}