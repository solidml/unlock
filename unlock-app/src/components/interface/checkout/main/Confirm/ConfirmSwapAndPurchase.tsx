import { useAuth } from '~/contexts/AuthenticationContext'
import { CheckoutService } from './../checkoutMachine'
import { useConfig } from '~/utils/withConfig'
import { Button } from '@unlock-protocol/ui'
import { Fragment, useRef, useState } from 'react'
import { ToastHelper } from '~/components/helpers/toast.helper'
import { useSelector } from '@xstate/react'
import { PoweredByUnlock } from '../../PoweredByUnlock'
import { MAX_UINT } from '~/constants'
import { Pricing } from '../../Lock'
import { getReferrer, lockTickerSymbol } from '~/utils/checkoutLockUtils'
import { Lock } from '~/unlockTypes'
import ReCaptcha from 'react-google-recaptcha'
import { RiErrorWarningFill as ErrorIcon } from 'react-icons/ri'
import { useUpdateUsersMetadata } from '~/hooks/useUserMetadata'
import { usePricing } from '~/hooks/usePricing'
import { usePurchaseData } from '~/hooks/usePurchaseData'
import { ethers } from 'ethers'
import { formatNumber } from '~/utils/formatter'
import { PricingData } from './PricingData'
import Disconnect from '../Disconnect'

interface Props {
  checkoutService: CheckoutService
  onConfirmed: (lock: string, network: number, hash?: string) => void
  onError: (message: string) => void
}

export function ConfirmSwapAndPurchase({
  checkoutService,
  onConfirmed,
}: Props) {
  const {
    lock,
    recipients,
    payment,
    paywallConfig,
    keyManagers,
    metadata,
    data,
    renew,
  } = useSelector(checkoutService, (state) => state.context)
  const { getWalletService } = useAuth()
  const config = useConfig()
  const recaptchaRef = useRef<any>()
  const [isConfirming, setIsConfirming] = useState(false)

  const { address: lockAddress, network: lockNetwork, keyPrice } = lock!

  // @ts-expect-error Property 'route' does not exist on type '{ method: "card"; cardId?: string | undefined; }'.
  const route = payment.route

  const currencyContractAddress = route.trade.inputAmount.currency?.address

  const recurringPayment =
    paywallConfig?.recurringPayments ||
    paywallConfig?.locks[lockAddress]?.recurringPayments

  const totalApproval =
    typeof recurringPayment === 'string' &&
    recurringPayment.toLowerCase() === 'forever' &&
    payment.method === 'crypto'
      ? MAX_UINT
      : undefined

  const recurringPaymentAmount = recurringPayment
    ? Math.abs(Math.floor(Number(recurringPayment)))
    : undefined

  const recurringPayments: number[] | undefined = recurringPaymentAmount
    ? new Array(recipients.length).fill(recurringPaymentAmount)
    : undefined

  const { mutateAsync: updateUsersMetadata } = useUpdateUsersMetadata()

  const { isInitialLoading: isInitialDataLoading, data: purchaseData } =
    usePurchaseData({
      lockAddress: lock!.address,
      network: lock!.network,
      paywallConfig,
      recipients,
      data,
    })

  const {
    data: pricingData,
    isInitialLoading: isPricingDataLoading,
    isError: isPricingDataError,
  } = usePricing({
    lockAddress: lock!.address,
    network: lock!.network,
    recipients,
    currencyContractAddress: lock?.currencyContractAddress,
    data: purchaseData!,
    paywallConfig,
    enabled: !isInitialDataLoading,
    symbol: lockTickerSymbol(
      lock as Lock,
      config.networks[lock!.network].nativeCurrency.symbol
    ),
    payment,
  })

  const isPricingDataAvailable =
    !isPricingDataLoading && !isPricingDataError && !!pricingData

  const isLoading = isPricingDataLoading || isInitialDataLoading

  const symbol = route.trade.inputAmount.currency.symbol

  const onError = (error: any, message?: string) => {
    console.error(error)
    switch (error.code) {
      case -32000:
      case 4001:
      case 'ACTION_REJECTED':
        ToastHelper.error('Transaction rejected.')
        break
      default:
        ToastHelper.error(message || error?.error?.message || error.message)
    }
  }

  const onConfirmCrypto = async () => {
    if (!pricingData) {
      return
    }
    try {
      setIsConfirming(true)
      const keyPrices: string[] =
        pricingData?.prices.map((item) => item.amount.toString()) ||
        new Array(recipients!.length).fill(keyPrice)

      const referrers: string[] = recipients.map((recipient: string) => {
        return getReferrer(recipient, paywallConfig, lockAddress)
      })

      const onErrorCallback = (error: Error | null, hash: string | null) => {
        setIsConfirming(false)
        if (error) {
          checkoutService.send({
            type: 'CONFIRM_MINT',
            status: 'ERROR',
            transactionHash: hash!,
          })
        } else if (hash) {
          onConfirmed(lockAddress, lock!.network, hash)
        }
      }
      const swap = {
        srcTokenAddress: currencyContractAddress,
        uniswapRouter: route.swapRouter,
        swapCallData: route.swapCalldata,
        value: route.value,
        amountInMax:
          (ethers.parseUnits(
            route!.quote.toFixed(),
            route.trade.inputAmount.currency.decimals
          ) *
            // 1% slippage buffer
            BigInt(101)) /
          BigInt(100),
      }

      const walletService = await getWalletService(lockNetwork)
      if (renew) {
        await walletService.extendKey({
          lockAddress,
          keyPrice,
          owner: recipients?.[0],
          data: purchaseData?.[0] || '0x',
          referrer: referrers?.[0],
          swap,
        })
      } else {
        await walletService.purchaseKeys(
          {
            lockAddress,
            keyPrices,
            owners: recipients!,
            data: purchaseData,
            keyManagers: keyManagers?.length ? keyManagers : undefined,
            recurringPayments,
            referrers,
            totalApproval,
            swap,
          },
          {} /** Transaction params */,
          onErrorCallback
        )
      }
    } catch (error: any) {
      setIsConfirming(false)
      onError(error)
    }
  }

  let buttonLabel = ''
  if (isConfirming) {
    buttonLabel = 'Paying using crypto'
  } else {
    buttonLabel = 'Pay using crypto'
  }

  return (
    <Fragment>
      <ReCaptcha
        ref={recaptchaRef}
        sitekey={config.recaptchaKey}
        size="invisible"
        badge="bottomleft"
      />

      <main className="h-full p-6 space-y-2 overflow-auto">
        <div className="grid gap-y-2">
          <h4 className="text-xl font-bold"> {lock!.name}</h4>
          {isPricingDataError && (
            // TODO: use actual error from simulation
            <div>
              <p className="text-sm font-bold">
                <ErrorIcon className="inline" />
                There was an error when preparing the transaction.
              </p>
            </div>
          )}
          {!isLoading && isPricingDataAvailable && (
            <PricingData
              network={lockNetwork}
              lock={lock!}
              pricingData={pricingData}
              payment={payment}
            />
          )}
        </div>

        {isLoading && (
          <div className="flex flex-col items-center gap-2">
            {recipients.map((user) => (
              <div
                key={user}
                className="w-full p-4 bg-gray-100 rounded-lg animate-pulse"
              />
            ))}
          </div>
        )}

        {pricingData && (
          <Pricing
            isCardEnabled={false}
            keyPrice={
              pricingData.total <= 0
                ? 'FREE'
                : `${formatNumber(
                    pricingData.total
                  ).toLocaleString()} ${symbol}`
            }
          />
        )}
      </main>
      <footer className="grid items-center px-6 pt-6 border-t">
        <div className="grid">
          <Button
            loading={isConfirming}
            disabled={isConfirming || isLoading || isPricingDataError}
            onClick={async (event) => {
              event.preventDefault()
              if (metadata) {
                await updateUsersMetadata(metadata)
              }
              onConfirmCrypto()
            }}
          >
            {buttonLabel}
          </Button>
        </div>
        <Disconnect service={checkoutService} />
        <PoweredByUnlock />
      </footer>
    </Fragment>
  )
}
