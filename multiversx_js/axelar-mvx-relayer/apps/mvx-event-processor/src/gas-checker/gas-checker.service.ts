import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ProviderKeys } from '@mvx-monorepo/common/utils/provider.enum';
import { UserSigner } from '@TerraDharitri/sdk-wallet/out';
import { TransactionsHelper } from '@mvx-monorepo/common/contracts/transactions.helper';
import { Locker } from '@TerraDharitri/sdk-nestjs-common';
import { ApiNetworkProvider } from '@TerraDharitri/sdk-network-providers/out';
import { CONSTANTS } from '@mvx-monorepo/common/utils/constants.enum';
import { WrewaSwapContract } from '@mvx-monorepo/common/contracts/wrewa-swap.contract';
import { FungibleTokenOfAccountOnNetwork } from '@TerraDharitri/sdk-network-providers/out/tokens';
import BigNumber from 'bignumber.js';
import { GasServiceContract } from '@mvx-monorepo/common/contracts/gas-service.contract';
import { IAddress } from '@TerraDharitri/sdk-network-providers/out/interface';
import { GetOrSetCache } from '@mvx-monorepo/common/decorators/get.or.set.cache';
import { CacheInfo } from '@mvx-monorepo/common';
import { SlackApi } from '@mvx-monorepo/common/api/slack.api';

const REWA_COLLECT_THRESHOLD = new BigNumber('300000000000000000'); // 0.3 REWA
const REWA_REFUND_RESERVE = new BigNumber('100000000000000000'); // 0.1 REWA

const REWA_LOW_ERROR_THRESHOLD = new BigNumber('100000000000000000'); // 0.1 REWA
const WREWA_CONVERT_THRESHOLD = new BigNumber('200000000000000000'); // 0.2 WREWA

@Injectable()
export class GasCheckerService {
  private readonly logger: Logger;

  constructor(
    @Inject(ProviderKeys.WALLET_SIGNER) private readonly walletSigner: UserSigner,
    private readonly transactionsHelper: TransactionsHelper,
    private readonly api: ApiNetworkProvider,
    private readonly wrewaSwapContract: WrewaSwapContract,
    private readonly gasServiceContract: GasServiceContract,
    private readonly slackApi: SlackApi,
  ) {
    this.logger = new Logger(GasCheckerService.name);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async checkGasServiceAndWallet() {
    await Locker.lock('checkGasServiceAndWallet', async () => {
      await this.checkGasServiceAndWalletRaw();
    });
  }

  async checkGasServiceAndWalletRaw() {
    this.logger.debug('Running checkGasServiceAndWallet cron');

    this.logger.log(`Checking gas service fees with address ${this.gasServiceContract.getContractAddress().bech32()}`);

    // First check gas service fees and collect them if necessary
    try {
      await this.checkGasServiceFees();

      this.logger.log('Checked gas service fees successfully');
    } catch (e) {
      this.logger.error('Error while trying to collect Gas Service fees...', e);
      await this.slackApi.sendError('Gas service fees error', 'Error while trying to collect Gas Service fees...');
    }

    this.logger.log(`Checking wallet signer balance with address ${this.walletSigner.getAddress().bech32()}`);

    try {
      await this.checkWalletTokens();

      this.logger.log('Checked wallet signer balance successfully');
    } catch (e) {
      this.logger.error('Error while checking wallet signer balance...', e);
      await this.slackApi.sendError('Gas wallet tokens error', 'Error while checking wallet signer balance...');
    }
  }

  private async checkGasServiceFees() {
    const tokens = await this.getAccountRewaAndWrewa(this.gasServiceContract.getContractAddress());
    const tokensToCollect = Object.values(tokens)
      .filter((token) => token.balance.gte(REWA_COLLECT_THRESHOLD))
      .map((token) => {
        // Leave some tokens in the contract in case of refunds
        token.balance = token.balance.minus(REWA_REFUND_RESERVE);

        return token;
      });

    if (!tokensToCollect.length) {
      this.logger.log('No fees to collect currently');

      return;
    }

    this.logger.log(
      'Trying to collect fees from gas service for: ' +
        tokensToCollect.map((token) => `${token.identifier} - ${token.balance}`),
    );

    const transaction = this.gasServiceContract.collectFees(
      this.walletSigner.getAddress(),
      tokensToCollect.map((token) => token.identifier),
      tokensToCollect.map((token) => token.balance),
    );

    const txHash = await this.transactionsHelper.signAndSendTransactionAndGetNonce(transaction, this.walletSigner);

    const success = await this.transactionsHelper.awaitSuccess(txHash);

    if (!success) {
      throw new Error(`Error while executing transaction ${txHash}`);
    }

    this.logger.log(`Successfully collected fees from gas service with transaction: ${txHash}!`);
  }

  private async checkWalletTokens() {
    const tokens = await this.getAccountRewaAndWrewa(this.walletSigner.getAddress());

    if (tokens.wrewaToken.balance.gte(WREWA_CONVERT_THRESHOLD)) {
      this.logger.log(`Trying to convert ${tokens.wrewaToken.balance} wrewa token to rewa for wallet`);

      const wrewa = tokens.wrewaToken;

      const transaction = this.wrewaSwapContract.unwrapRewa(
        wrewa.identifier,
        wrewa.balance,
        this.walletSigner.getAddress(),
      );

      const txHash = await this.transactionsHelper.signAndSendTransactionAndGetNonce(transaction, this.walletSigner);

      const success = await this.transactionsHelper.awaitSuccess(txHash);

      if (!success) {
        throw new Error(`Error while executing unwrap rewa transaction ${txHash}`);
      }

      this.logger.log('Successfully converted wrewa token to rewa for wallet');

      // Retrieve new REWA balance
      tokens.rewaToken.balance = (await this.api.getAccount(this.walletSigner.getAddress())).balance;
    }

    if (tokens.rewaToken.balance.lt(REWA_LOW_ERROR_THRESHOLD)) {
      this.logger.error('Low balance for signer wallet! Consider manually topping up REWA!');
      await this.slackApi.sendError(
        'Wallet low balance error',
        'Low balance for signer wallet! Consider manually topping up REWA!',
      );
    }
  }

  private async getAccountRewaAndWrewa(
    address: IAddress,
  ): Promise<{ rewaToken: FungibleTokenOfAccountOnNetwork; wrewaToken: FungibleTokenOfAccountOnNetwork }> {
    const account = await this.api.getAccount(address);
    const rewaToken: FungibleTokenOfAccountOnNetwork = {
      identifier: CONSTANTS.REWA_IDENTIFIER,
      balance: account.balance,
      rawResponse: {},
    };

    const wrewaTokenId = await this.getWrewaTokenId();
    let wrewaToken: FungibleTokenOfAccountOnNetwork;
    try {
      wrewaToken = await this.api.getFungibleTokenOfAccount(address, wrewaTokenId);
    } catch (e) {
      this.logger.warn(`Could not get wrewa balance for ${address.bech32()}`);
      await this.slackApi.sendWarn('Gas checker error', `Could not get wrewa balance for ${address.bech32()}`);

      wrewaToken = {
        identifier: wrewaTokenId,
        balance: new BigNumber(0),
        rawResponse: {},
      };
    }

    return { rewaToken, wrewaToken };
  }

  @GetOrSetCache(CacheInfo.WrewaTokenId)
  private async getWrewaTokenId(): Promise<string> {
    return await this.wrewaSwapContract.getWrappedRewaTokenId();
  }
}
