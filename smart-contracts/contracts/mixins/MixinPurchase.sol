// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import './MixinDisable.sol';
import './MixinKeys.sol';
import './MixinLockCore.sol';
import './MixinFunds.sol';

/**
 * @title Mixin for the purchase-related functions.
 * @author HardlyDifficult
 * @dev `Mixins` are a design pattern seen in the 0x contracts.  It simply
 * separates logically groupings of code to ease readability.
 */
contract MixinPurchase is
  MixinFunds,
  MixinDisable,
  MixinLockCore,
  MixinKeys
{
  event RenewKeyPurchase(address indexed owner, uint newExpiration);

  event GasRefunded(address indexed receiver, uint refundedAmount, address tokenAddress);
  
  event UnlockCallFailed(address indexed lockAddress, address unlockAddress);

  // default to 0%  
  uint128 private _gasRefundBasisPoints = 0; 

  /**
  * @dev Set a percentage as basis point (10000th) of the key price to be refunded to the sender on purchase
  */

  function setGasRefundBasisPoints(uint128 _basisPoints) external onlyLockManager {
    _gasRefundBasisPoints = _basisPoints;
  }
  
  /**
  * @dev Returns percentage as basis point (10000th) to be refunded to the sender on purchase
  */
  function gasRefundBasisPoints() external view returns (uint128 basisPoints) {
    return _gasRefundBasisPoints;
  }

  /**
  * @dev Purchase function
  * @param _value the number of tokens to pay for this purchase >= the current keyPrice - any applicable discount
  * (_value is ignored when using ETH)
  * @param _recipient address of the recipient of the purchased key
  * @param _referrer address of the user making the referral
  * @param _keyManager optional address to grant managing rights to a specific address on creation
  * @param _data arbitrary data populated by the front-end which initiated the sale
  * @notice when called for an existing and non-expired key, the `_keyManager` param will be ignored 
  * @dev Setting _value to keyPrice exactly doubles as a security feature. That way if the lock owner increases the
  * price while my transaction is pending I can't be charged more than I expected (only applicable to ERC-20 when more
  * than keyPrice is approved for spending).
  */
  function purchase(
    uint256 _value,
    address _recipient,
    address _referrer,
    address _keyManager,
    bytes calldata _data
  ) external payable
    onlyIfAlive
    notSoldOut
  {
    require(_recipient != address(0), 'INVALID_ADDRESS');

    // Assign the key
    Key storage toKey = keyByOwner[_recipient];
    uint idTo = toKey.tokenId;
    uint newTimeStamp;

    if (idTo == 0) {
      // Assign a new tokenId (if a new owner or previously transferred)
      _assignNewTokenId(toKey);
      // refresh the cached value
      idTo = toKey.tokenId;
      _recordOwner(_recipient, idTo);
      // check for a non-expiring key
      if (expirationDuration == type(uint).max) {
        newTimeStamp = type(uint).max;
      } else {
        newTimeStamp = block.timestamp + expirationDuration;
      }
      toKey.expirationTimestamp = newTimeStamp;

      // set key manager
      _setKeyManagerOf(idTo, _keyManager);

      // trigger event
      emit Transfer(
        address(0), // This is a creation.
        _recipient,
        idTo
      );
    } else if (toKey.expirationTimestamp > block.timestamp) {
      // prevent re-purchase of a valid non-expiring key
      require(toKey.expirationTimestamp != type(uint).max, 'A valid non-expiring key can not be purchased twice');

      // This is an existing owner trying to extend their key
      newTimeStamp = toKey.expirationTimestamp + expirationDuration;
      toKey.expirationTimestamp = newTimeStamp;

      emit RenewKeyPurchase(_recipient, newTimeStamp);
    } else {
      // This is an existing owner trying to renew their expired or cancelled key
      if(expirationDuration == type(uint).max) {
        newTimeStamp = type(uint).max;
      } else {
        newTimeStamp = block.timestamp + expirationDuration;
      }
      toKey.expirationTimestamp = newTimeStamp;

      _setKeyManagerOf(idTo, _keyManager);

      emit RenewKeyPurchase(_recipient, newTimeStamp);
    }

    
    uint inMemoryKeyPrice = _purchasePriceFor(_recipient, _referrer, _data);

    try unlockProtocol.recordKeyPurchase(inMemoryKeyPrice, _referrer) 
    {} 
    catch {
      // emit missing unlock
      emit UnlockCallFailed(address(this), address(unlockProtocol));
    }

    // We explicitly allow for greater amounts of ETH or tokens to allow 'donations'
    uint pricePaid;
    if(tokenAddress != address(0))
    {
      pricePaid = _value;
      IERC20Upgradeable token = IERC20Upgradeable(tokenAddress);
      token.transferFrom(msg.sender, address(this), pricePaid);
    }
    else
    {
      pricePaid = msg.value;
    }
    require(pricePaid >= inMemoryKeyPrice, 'INSUFFICIENT_VALUE');

    if(address(onKeyPurchaseHook) != address(0))
    {
      onKeyPurchaseHook.onKeyPurchase(msg.sender, _recipient, _referrer, _data, inMemoryKeyPrice, pricePaid);
    }

    // refund gas
    if (_gasRefundBasisPoints != 0) {
      uint toRefund = _gasRefundBasisPoints * pricePaid / BASIS_POINTS_DEN;
      if(tokenAddress != address(0)) {
        IERC20Upgradeable token = IERC20Upgradeable(tokenAddress);
        token.transferFrom(address(this), msg.sender, toRefund);
      } else {
        (bool success, ) = msg.sender.call{value: toRefund}("");
        require(success, "Refund failed.");
      }
      emit GasRefunded(msg.sender, toRefund, tokenAddress);
    }
  }

  /**
   * @notice returns the minimum price paid for a purchase with these params.
   * @dev minKeyPrice considers any discount from Unlock or the OnKeyPurchase hook
   */
  function purchasePriceFor(
    address _recipient,
    address _referrer,
    bytes calldata _data
  ) external view
    returns (uint minKeyPrice)
  {
    minKeyPrice = _purchasePriceFor(_recipient, _referrer, _data);
  }

  /**
   * @notice returns the minimum price paid for a purchase with these params.
   * @dev minKeyPrice considers any discount from Unlock or the OnKeyPurchase hook
   */
  function _purchasePriceFor(
    address _recipient,
    address _referrer,
    bytes memory _data
  ) internal view
    returns (uint minKeyPrice)
  {
    if(address(onKeyPurchaseHook) != address(0))
    {
      minKeyPrice = onKeyPurchaseHook.keyPurchasePrice(msg.sender, _recipient, _referrer, _data);
    }
    else
    {
      minKeyPrice = keyPrice;
    }
    return minKeyPrice;
  }
}
