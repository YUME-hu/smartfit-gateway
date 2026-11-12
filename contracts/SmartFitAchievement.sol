// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SmartFitAchievement — 运动里程碑成就（Soulbound / 不可转让）
 *
 * 设计取舍（答辩会被问到，写在最前面）：
 *  1. **不引 OpenZeppelin**：整个合约自包含，Remix 里直接粘贴即可编译，
 *     不需要 npm 依赖解析。代价是只实现了 ERC721 的只读子集，
 *     不实现 transfer/approve —— SBT 本来就不需要。
 *  2. **一人一枚**：`mint` 里检查 balanceOf == 0，防止刷号。
 *     真正的防作弊应该是服务端 EIP-712 签名，见文末 TODO。
 *  3. **元数据完全上链**：tokenURI 直接在链上拼 base64 的 JSON + SVG，
 *     不依赖 IPFS/中心化服务器，Explorer 和钱包都能直接读到。
 *  4. **等级与经验做一致性校验**：防止客户端随便填 Lv5 + 0 经验。
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

    // ---------------------------------------------------------------- 错误

    error NotEligible();
    error AlreadyMinted();
    error InvalidLevel();
    error LevelExpMismatch();
    error Soulbound();
    error TokenNotExist();

    // ---------------------------------------------------------------- 铸造

    /**
     * @notice 领取里程碑成就
     * @param exp    当前累计经验
     * @param steps  当前累计步数
     * @param level  当前等级（1~5）
     *
     * 注意：数据由客户端申报。MVP 阶段没有服务端签名校验，
     * 所以"可信度"依赖于一人一枚 + 门槛校验。升级方案见 TODO。
     */
    function mint(uint32 exp, uint32 steps, uint8 level) external returns (uint256 tokenId) {
        if (_tokenOf[msg.sender] != 0) revert AlreadyMinted();
        if (level == 0 || level > 5) revert InvalidLevel();

        // 门槛：经验够 或 步数够
        if (exp < MIN_EXP && steps < MIN_STEPS) revert NotEligible();

        // 等级必须与经验区间吻合（阈值与前端 petRules.ts 一致）
        if (exp < minExpForLevel(level)) revert LevelExpMismatch();
        if (level < 5 && exp >= minExpForLevel(uint8(level + 1))) revert LevelExpMismatch();

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

    function minExpForLevel(uint8 level) public pure returns (uint32) {
        if (level <= 1) return 0;
        if (level == 2) return 100;
        if (level == 3) return 300;
        if (level == 4) return 700;
        return 1500;
    }

    // ---------------------------------------------------------------- 只读

    function balanceOf(address owner) external view returns (uint256) {
        return _tokenOf[owner] == 0 ? 0 : 1;
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _owners[tokenId];
        if (o == address(0)) revert TokenNotExist();
        return o;
    }

    /// 地址持有的 tokenId（0 = 没有）
    function tokenOf(address owner) external view returns (uint256) {
        return _tokenOf[owner];
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

    // 任何转移/授权都直接 revert（Soulbound 的核心）
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
            interfaceId == 0xb45a3c0e;   // EIP-5192 (locked)
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

    // ---------------------------------------------------------------- TODO（升级方向）
    //
    // 目前 mint 的 exp/steps 是客户端自报，合约只做门槛与等级一致性校验。
    // 生产环境应该：
    //   1. 部署者设置一个可信 signer 地址；
    //   2. 后端（Fastify/Edge Function）读取 pet_state，用 EIP-712 签
    //      {to, exp, steps, level, nonce, deadline}；
    //   3. mint 里用 ecrecover 校验签名，并记录 nonce 防重放。
    // 这样链上数据才有可信来源，答辩时可以主动讲这一点。
}
