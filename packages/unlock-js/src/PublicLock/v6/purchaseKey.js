import utils from '../../utils'
import { ZERO } from '../../constants'
import { getErc20Decimals } from '../../erc20'
import approveAllowance from '../utils/approveAllowance'

/**
 * Purchase key function. This implementation requires the following
 * @param {object} params:
 * - {PropTypes.address} lockAddress
 * - {PropTypes.address} owner
 * - {string} keyPrice
 * - {PropTypes.address} erc20Address
 * - {number} decimals
 * - {PropTypes.address} referrer (address which will receive UDT - if applicable)
 * - {PropTypes.array[bytes]} data (array of bytes, not used in transaction but can be used by hooks)
 * @param {function} callback invoked with the transaction hash
 */
export default async function (
  {
    lockAddress,
    owner,
    keyPrice,
    erc20Address,
    decimals,
    referrer,
    data,
    swap,
  },
  transactionOptions = {},
  callback
) {
  const lockContract = await this.getLockContract(lockAddress)
  const unlockSwapPurchaserContract = swap
    ? this.getUnlockSwapPurchaserContract({
        params: {
          network: this.networkId,
        },
      })
    : null

  if (!owner) {
    owner = await this.signer.getAddress()
  }

  if (!referrer) {
    referrer = ZERO
  }

  if (!data) {
    data = '0x'
  }

  // If erc20Address was not provided, get it
  if (!erc20Address) {
    erc20Address = await lockContract.tokenAddress()
  }
  let actualAmount
  if (!keyPrice) {
    // We might not have the keyPrice, in which case, we need to retrieve from the the lock!
    actualAmount = await lockContract.keyPrice()
  } else if (decimals !== undefined && decimals !== null) {
    // We have have a keyPrice and decinals, we just use them.
    actualAmount = utils.toDecimal(keyPrice, decimals)
  } else {
    // get the decimals from the ERC20 contract or default to 18
    if (erc20Address && erc20Address !== ZERO) {
      decimals = await getErc20Decimals(erc20Address, this.provider)
    } else {
      decimals = 18
    }
    actualAmount = utils.toDecimal(keyPrice, decimals)
  }

  const purchaseArgs = [actualAmount, owner, referrer, data]
  const callData = lockContract.interface.encodeFunctionData(
    'purchase',
    purchaseArgs
  )

  // tx options
  if (!erc20Address || erc20Address === ZERO) {
    transactionOptions.value = actualAmount
  }

  // if swap is provided, we need to override the value
  if (swap && swap?.value) {
    transactionOptions.value = swap.value
  }

  // If the lock is priced in ERC20, we need to approve the transfer
  const approvalOptions = swap
    ? {
        erc20Address: swap.srcTokenAddress,
        address: unlockSwapPurchaserContract?.address,
        totalAmountToApprove: swap.amountInMax,
      }
    : {
        erc20Address,
        address: lockAddress,
        totalAmountToApprove: actualAmount,
      }

  // Only ask for approval if the lock or swap is priced in ERC20
  if (approvalOptions.erc20Address && approvalOptions.erc20Address !== ZERO) {
    await approveAllowance.bind(this)(approvalOptions)
  }

  // Estimate gas. Bump by 30% because estimates are wrong!
  if (!transactionOptions.gasLimit) {
    try {
      // To get good estimates we need the gas price, because it matters in the actual execution (UDT calculation takes it into account)
      // TODO remove once we move to use block.baseFee in UDT calculation
      const { gasPrice, maxFeePerGas, maxPriorityFeePerGas } =
        await this.provider.getFeeData()

      if (maxFeePerGas && maxPriorityFeePerGas) {
        transactionOptions.maxFeePerGas = maxFeePerGas
        transactionOptions.maxPriorityFeePerGas = maxPriorityFeePerGas
      } else {
        transactionOptions.gasPrice = gasPrice
      }

      const gasLimitPromise = swap
        ? unlockSwapPurchaserContract?.swapAndCall.estimateGas(
            lockAddress,
            swap.srcTokenAddress || ZERO,
            actualAmount,
            swap.amountInMax,
            swap.uniswapRouter,
            swap.swapCallData,
            callData,
            transactionOptions
          )
        : lockContract.purchase.estimateGas(
            actualAmount,
            owner,
            referrer,
            data,
            transactionOptions
          )

      const gasLimit = await gasLimitPromise
      // Remove the gas prices settings for the actual transaction (the wallet will set them)
      delete transactionOptions.maxFeePerGas
      delete transactionOptions.maxPriorityFeePerGas
      delete transactionOptions.gasPrice
      transactionOptions.gasLimit = (gasLimit * 13n) / 10n
    } catch (error) {
      console.error(
        'We could not estimate gas ourselves. Let wallet do it.',
        error
      )
      delete transactionOptions.maxFeePerGas
      delete transactionOptions.maxPriorityFeePerGas
      delete transactionOptions.gasPrice
    }
  }

  const transactionPromise = swap
    ? unlockSwapPurchaserContract?.swapAndCall(
        lockAddress,
        swap.srcTokenAddress || ZERO,
        actualAmount,
        swap.amountInMax,
        swap.uniswapRouter,
        swap.swapCallData,
        callData,
        transactionOptions
      )
    : lockContract.purchase(
        actualAmount,
        owner,
        referrer,
        data,
        transactionOptions
      )

  const hash = await this._handleMethodCall(transactionPromise)

  if (callback) {
    callback(null, hash, await transactionPromise)
  }

  // Let's now wait for the transaction to go thru to return the token id
  const receipt = await this.provider.waitForTransaction(hash)

  if (receipt.status === 0) {
    throw new Error('Transaction failed')
  }

  const parser = lockContract.interface

  const transferEvent = receipt.logs
    .map((log) => {
      if (log.address.toLowerCase() !== lockAddress.toLowerCase()) return // Some events are triggered by the ERC20 contract
      return parser.parseLog(log)
    })
    .find((evt) => evt && evt.fragment?.name === 'Transfer')

  if (transferEvent) {
    return transferEvent.args.tokenId.toString()
  }
  // There was no Transfer log (transaction failed?)
  return null
}
