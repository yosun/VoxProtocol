// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoxMediaNFT, IERC721Receiver} from "../VoxMediaNFT.sol";

contract StandardReceiver is IERC721Receiver {
    address public operator;
    address public from;
    uint256 public tokenId;
    bytes public data;

    function onERC721Received(address operator_, address from_, uint256 tokenId_, bytes calldata data_) external returns (bytes4) {
        operator = operator_;
        from = from_;
        tokenId = tokenId_;
        data = data_;
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract WrongReceiver is IERC721Receiver {
    uint256 public calls;
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        calls++;
        return 0xffffffff;
    }
}

contract RevertingReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("receiver declined");
    }
}

contract ShortReturnReceiver {
    fallback() external {
        assembly {
            mstore(0, 0x150b7a0200000000000000000000000000000000000000000000000000000000)
            return(0, 4)
        }
    }
}

contract NonReceiver {}

contract ApprovedOperator {
    function transfer(VoxMediaNFT nft, address from, address to, uint256 tokenId) external {
        nft.safeTransferFrom(from, to, tokenId, hex"1234");
    }
}

contract VoxMediaNFTTest {
    function testSafeTransferWithoutDataAcceptsAbiEncodedReceiver() external {
        VoxMediaNFT nft = new VoxMediaNFT("VOX", "VOX", address(this));
        StandardReceiver receiver = new StandardReceiver();
        uint256 tokenId = nft.mint(address(this), "https://vox.test/metadata/1");
        nft.safeTransferFrom(address(this), address(receiver), tokenId);
        require(nft.ownerOf(tokenId) == address(receiver), "recipient must own token");
        require(nft.balanceOf(address(this)) == 0 && nft.balanceOf(address(receiver)) == 1, "balances must move");
        require(receiver.operator() == address(this) && receiver.from() == address(this), "callback identity must match");
        require(receiver.tokenId() == tokenId && receiver.data().length == 0, "callback must receive empty data");
    }

    function testSafeTransferWithDataAcceptsAbiEncodedReceiver() external {
        VoxMediaNFT nft = new VoxMediaNFT("VOX", "VOX", address(this));
        StandardReceiver receiver = new StandardReceiver();
        ApprovedOperator operator = new ApprovedOperator();
        uint256 tokenId = nft.mint(address(this), "https://vox.test/metadata/1");
        nft.approve(address(operator), tokenId);
        operator.transfer(nft, address(this), address(receiver), tokenId);
        require(nft.ownerOf(tokenId) == address(receiver), "recipient must own token");
        require(nft.getApproved(tokenId) == address(0), "approval must clear");
        require(receiver.operator() == address(operator) && receiver.from() == address(this), "approved operator must reach callback");
        require(receiver.tokenId() == tokenId && keccak256(receiver.data()) == keccak256(hex"1234"), "callback data must match");
    }

    function testBothSafeTransferOverloadsAcceptEoa() external {
        VoxMediaNFT nft = new VoxMediaNFT("VOX", "VOX", address(this));
        address recipient = address(0xbeef);
        uint256 first = nft.mint(address(this), "uri:1");
        uint256 second = nft.mint(address(this), "uri:2");
        nft.safeTransferFrom(address(this), recipient, first);
        nft.safeTransferFrom(address(this), recipient, second, hex"beef");
        require(nft.ownerOf(first) == recipient && nft.ownerOf(second) == recipient, "EOA must receive both tokens");
        require(nft.balanceOf(recipient) == 2 && nft.balanceOf(address(this)) == 0, "EOA balances must match");
    }

    function testBothOverloadsRejectWrongReceiverAndRollback() external {
        WrongReceiver receiver = new WrongReceiver();
        _assertRejected(address(receiver));
        require(receiver.calls() == 0, "receiver side effects must roll back");
    }

    function testBothOverloadsRejectRevertingReceiverAndRollback() external {
        _assertRejected(address(new RevertingReceiver()));
    }

    function testBothOverloadsRejectShortReturnAndRollback() external {
        _assertRejected(address(new ShortReturnReceiver()));
    }

    function testBothOverloadsRejectNonReceiverAndRollback() external {
        _assertRejected(address(new NonReceiver()));
    }

    function _assertRejected(address receiver) private {
        VoxMediaNFT nft = new VoxMediaNFT("VOX", "VOX", address(this));
        uint256 tokenId = nft.mint(address(this), "https://vox.test/metadata/1");
        address approved = address(0xa11ce);
        nft.approve(approved, tokenId);
        for (uint256 overload = 0; overload < 2; overload++) {
            bytes memory callData = overload == 0
                ? abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(this), receiver, tokenId)
                : abi.encodeWithSignature("safeTransferFrom(address,address,uint256,bytes)", address(this), receiver, tokenId, hex"1234");
            (bool ok,) = address(nft).call(callData);
            require(!ok, "unsafe contract recipient must be rejected");
            require(nft.ownerOf(tokenId) == address(this), "ownership must roll back");
            require(nft.balanceOf(address(this)) == 1 && nft.balanceOf(receiver) == 0, "balances must roll back");
            require(nft.getApproved(tokenId) == approved, "approval must roll back");
        }
    }
}
