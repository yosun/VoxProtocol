// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

/// @title VOX Media NFT
/// @notice A small, non-upgradeable ERC-721 collection whose only privileged
/// operation is minting an immutable token URI. Deploy one instance per EVM
/// network and keep the minter key separate from all payment/settlement keys.
contract VoxMediaNFT {
    string public name;
    string public symbol;
    uint256 public nextTokenId = 1;
    address public owner;
    address public minter;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => string) private _tokenUris;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    error NotOwner();
    error NotMinter();
    error InvalidRecipient();
    error NonexistentToken();
    error NotAuthorized();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event MinterChanged(address indexed previousMinter, address indexed newMinter);

    constructor(string memory collectionName, string memory collectionSymbol, address initialMinter) {
        if (initialMinter == address(0)) revert InvalidRecipient();
        name = collectionName;
        symbol = collectionSymbol;
        owner = msg.sender;
        minter = initialMinter;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert InvalidRecipient();
        emit MinterChanged(minter, newMinter);
        minter = newMinter;
    }

    function balanceOf(address account) external view returns (uint256) {
        if (account == address(0)) revert InvalidRecipient();
        return _balances[account];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert NonexistentToken();
        return tokenOwner;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return _tokenUris[tokenId];
    }

    function approve(address approved, uint256 tokenId) external {
        address tokenOwner = ownerOf(tokenId);
        if (msg.sender != tokenOwner && !_operatorApprovals[tokenOwner][msg.sender]) revert NotAuthorized();
        _tokenApprovals[tokenId] = approved;
        emit Approval(tokenOwner, approved, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address tokenOwner, address operator) external view returns (bool) {
        return _operatorApprovals[tokenOwner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address tokenOwner = ownerOf(tokenId);
        if (tokenOwner != from || to == address(0)) revert InvalidRecipient();
        if (msg.sender != tokenOwner && msg.sender != _tokenApprovals[tokenId] && !_operatorApprovals[tokenOwner][msg.sender]) revert NotAuthorized();
        delete _tokenApprovals[tokenId];
        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external {
        transferFrom(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, data);
    }

    function _checkOnERC721Received(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length != 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 returned) {
                if (returned != IERC721Receiver.onERC721Received.selector) revert NotAuthorized();
            } catch {
                revert NotAuthorized();
            }
        }
    }

    function mint(address to, string calldata uri) external onlyMinter returns (uint256 tokenId) {
        if (to == address(0)) revert InvalidRecipient();
        tokenId = nextTokenId++;
        _owners[tokenId] = to;
        _balances[to] += 1;
        _tokenUris[tokenId] = uri;
        emit Transfer(address(0), to, tokenId);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }
}
