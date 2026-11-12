// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SmartFitAchievement — 运动里程碑成就（Soulbound / 不可转让）
 *
 * v2：加入 EIP-712 签名校验 + Nonce 防重放
 *
 * 为什么必须有签名（这是 v1 最大的问题）：
 *   v1 的 exp/steps 是浏览器传进来的，改个数字就能拿"Lv5 成就"。
 *   v2 要求这些数据由**后端签名**：签名里绑定
 *       to（领取人）、exp、steps、level、nonce、deadline
 *   合约用 ecrecover 还原签名者，必须等于部署时指定的 signer。
 *   于是浏览器只能"转交"签名，不能伪造内容。
 *
 * 复用的安全细节：
 *   1. nonce 每人自增，签名只能用一次（防重放）
 *   2. deadline 限时，防止旧签名长期有效
 *   3. 签名里带 to，别人拿到你的签名也用不了（地址不匹配）
 *   4. s 值范围检查（防签名可锻造性 / malleability）
 *
 * 仍然保留"一人一枚"，所以实际上一个地址只能铸造一次。
 */
contract SmartFitAchievement {
    // ---------------------------------------------------------------- 元数据

    string public constant name = "SmartFit Milestone";
    string public constant symbol = "SFMS";
    string public constant description =
        unicode"SmartFit 运动里程碑成就 / Soulbound (non-transferable)";

    /// 上链门槛：经验 >= 300 或累计步数 >= 5000
    uint32 public constant MIN_EXP = 300;
    uint32 public constant MIN_STEPS = 5000;

    // ---------------------------------------------------------------- EIP-712

    bytes32 public constant ACHIEVEMENT_TYPEHASH =
        keccak256(
            "Achievement(address to,uint32 exp,uint32 steps,uint8 level,uint256 nonce,uint256 deadline)"
        );

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant NAME_HASH = keccak256("SmartFitAchievement");
    bytes32 private constant VERSION_HASH = keccak256("1");

    address public owner;
    /// 可信签名者（后端签名服务对应的地址）
    address public signer;

    // ---------------------------------------------------------------- 存储

    struct Achievement {
        uint32 exp;
        uint32 steps;
        uint8 level;
        uint64 mintedAt;
    }

    uint256 private _nextId = 1;
    uint256 private _totalSupply;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _tokenOf; // 每人一枚，0 = 未持有
    mapping(uint256 => Achievement) private _achievement;
    mapping(address => uint256) private _nonces;

    // ---------------------------------------------------------------- 事件

    event AchievementMinted(
        address indexed to,
        uint256 indexed tokenId,
        uint32 exp,
        uint32 steps,
        uint8 level
    );

    /// EIP-5192 Minimal Soulbound NFT
    event Locked(uint256 tokenId);

    event SignerChanged(address indexed previous, address indexed current);

    // ---------------------------------------------------------------- 错误

    error NotEligible();
    error AlreadyMinted();
    error InvalidLevel();
    error LevelExpMismatch();
    error Soulbound();
    error TokenNotExist();
    error SignatureExpired();
    error BadNonce();
    error BadSignature();
    error NotOwner();

    constructor(address initialSigner) {
        owner = msg.sender;
        signer = initialSigner;
        emit SignerChanged(address(0), initialSigner);
    }

    // ---------------------------------------------------------------- 管理

    function setSigner(address next) external {
        if (msg.sender != owner) revert NotOwner();
        emit SignerChanged(signer, next);
        signer = next;
    }

    /// 当前 nonce（签名里要带它，前端读这个值去请求签名）
    function nonces(address who) external view returns (uint256) {
        return _nonces[who];
    }

    function domainSeparator() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
            );
    }

    // ---------------------------------------------------------------- 铸造

    /**
     * @notice 领取里程碑成就（需要后端 EIP-712 签名）
     * @param exp        累计经验（由签名担保）
     * @param steps      累计步数（由签名担保）
     * @param level      等级（由签名担保）
     * @param deadline   签名有效期（unix 秒）
     * @param signature  后端对上述数据的 EIP-712 签名
     */
    function mint(
        uint32 exp,
        uint32 steps,
        uint8 level,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 tokenId) {
        if (_tokenOf[msg.sender] != 0) revert AlreadyMinted();
        if (level == 0 || level > 5) revert InvalidLevel();

        // 门槛：经验够 或 步数够
        if (exp < MIN_EXP && steps < MIN_STEPS) revert NotEligible();

        // 等级必须与经验区间吻合（阈值与前端 petRules.ts 一致）
        if (exp < minExpForLevel(level)) revert LevelExpMismatch();
        if (level < 5 && exp >= minExpForLevel(uint8(level + 1))) revert LevelExpMismatch();

        _verifySignature(msg.sender, exp, steps, level, deadline, signature);

        tokenId = _nextId++;
        _owners[tokenId] = msg.sender;
        _tokenOf[msg.sender] = tokenId;
        _achievement[tokenId] = Achievement({
            exp: exp,
            steps: steps,
            level: level,
            mintedAt: uint64(block.timestamp)
        });
        unchecked {
            _totalSupply += 1;
        }

        emit AchievementMinted(msg.sender, tokenId, exp, steps, level);
        emit Locked(tokenId);
    }

    function _verifySignature(
        address to,
        uint32 exp,
        uint32 steps,
        uint8 level,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        if (block.timestamp > deadline) revert SignatureExpired();

        uint256 nonce = _nonces[to];
        bytes32 structHash = keccak256(
            abi.encode(ACHIEVEMENT_TYPEHASH, to, exp, steps, level, nonce, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));

        if (_recover(digest, signature) != signer) revert BadSignature();

        // 用掉这个 nonce，同一份签名无法再次使用
        unchecked {
            _nonces[to] = nonce + 1;
        }
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();

        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);

        // v 只允许 27/28（不接受 0/1，避免跨链/异构签名歧义）
        if (v != 27 && v != 28) revert BadSignature();
        // s 必须 <= secp256k1n/2，否则签名可锻造
        if (
            uint256(s) >
            0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
        ) revert BadSignature();

        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) revert BadSignature();
        return recovered;
    }

    function minExpForLevel(uint8 level) public pure returns (uint32) {
        if (level <= 1) return 0;
        if (level == 2) return 100;
        if (level == 3) return 300;
        if (level == 4) return 700;
        return 1500;
    }

    // ---------------------------------------------------------------- 只读

    function balanceOf(address who) external view returns (uint256) {
        return _tokenOf[who] == 0 ? 0 : 1;
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _owners[tokenId];
        if (o == address(0)) revert TokenNotExist();
        return o;
    }

    /// 地址持有的 tokenId（0 = 没有）
    function tokenOf(address who) external view returns (uint256) {
        return _tokenOf[who];
    }

    function achievementOf(uint256 tokenId) external view returns (Achievement memory) {
        if (_owners[tokenId] == address(0)) revert TokenNotExist();
        return _achievement[tokenId];
    }

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    /// EIP-5192：永久锁定
    function locked(uint256 tokenId) external view returns (bool) {
        if (_owners[tokenId] == address(0)) revert TokenNotExist();
        return true;
    }

    // ---------------------------------------------------------------- 元数据

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert TokenNotExist();

        Achievement memory a = _achievement[tokenId];

        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">',
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
            '<stop offset="0" stop-color="#3d7eff"/><stop offset="1" stop-color="#3ddc84"/>',
            "</linearGradient></defs>",
            '<rect width="300" height="300" rx="28" fill="#0f1115"/>',
            '<circle cx="150" cy="118" r="60" fill="url(#g)"/>',
            '<text x="150" y="133" font-family="monospace" font-size="44" font-weight="bold"',
            ' fill="#0f1115" text-anchor="middle">Lv',
            _toString(a.level),
            "</text>",
            '<text x="150" y="212" font-family="monospace" font-size="17"',
            ' fill="#9dc0ff" text-anchor="middle">EXP ',
            _toString(a.exp),
            "</text>",
            '<text x="150" y="238" font-family="monospace" font-size="17"',
            ' fill="#8ef0b7" text-anchor="middle">STEPS ',
            _toString(a.steps),
            "</text>",
            '<text x="150" y="270" font-family="monospace" font-size="12"',
            ' fill="#5f6779" text-anchor="middle">SmartFit / Soulbound</text>',
            "</svg>"
        );

        string memory json = string.concat(
            '{"name":"SmartFit Milestone #',
            _toString(tokenId),
            '","description":"',
            description,
            '","attributes":[',
            '{"trait_type":"Level","value":',
            _toString(a.level),
            "},",
            '{"trait_type":"EXP","value":',
            _toString(a.exp),
            "},",
            '{"trait_type":"Steps","value":',
            _toString(a.steps),
            "}],",
            '"image":"data:image/svg+xml;base64,',
            _base64(bytes(svg)),
            '"}'
        );

        return string.concat("data:application/json;base64,", _base64(bytes(json)));
    }

    // ---------------------------------------------------------------- SBT 锁死

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    // ---------------------------------------------------------------- ERC165

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC165
            interfaceId == 0x80ac58cd || // ERC721（只读子集）
            interfaceId == 0xb45a3c0e;   // EIP-5192
    }

    // ---------------------------------------------------------------- 工具

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    /// 标准 base64（非汇编实现，便于审阅）
    function _base64(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";

        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        uint256 len = data.length;
        uint256 outLen = 4 * ((len + 2) / 3);
        bytes memory out = new bytes(outLen);

        uint256 i;
        uint256 j;
        for (; i + 3 <= len; i += 3) {
            uint256 n = (uint256(uint8(data[i])) << 16) |
                (uint256(uint8(data[i + 1])) << 8) |
                uint256(uint8(data[i + 2]));
            out[j++] = table[(n >> 18) & 63];
            out[j++] = table[(n >> 12) & 63];
            out[j++] = table[(n >> 6) & 63];
            out[j++] = table[n & 63];
        }

        uint256 rem = len - i;
        if (rem == 1) {
            uint256 n = uint256(uint8(data[i])) << 16;
            out[j++] = table[(n >> 18) & 63];
            out[j++] = table[(n >> 12) & 63];
            out[j++] = "=";
            out[j++] = "=";
        } else if (rem == 2) {
            uint256 n = (uint256(uint8(data[i])) << 16) | (uint256(uint8(data[i + 1])) << 8);
            out[j++] = table[(n >> 18) & 63];
            out[j++] = table[(n >> 12) & 63];
            out[j++] = table[(n >> 6) & 63];
            out[j++] = "=";
        }

        return string(out);
    }
}
