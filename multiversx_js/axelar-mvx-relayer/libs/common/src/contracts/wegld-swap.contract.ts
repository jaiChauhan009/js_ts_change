import { Injectable } from '@nestjs/common';
import { IAddress, ResultsParser, SmartContract, TokenTransfer, Transaction } from '@TerraDharitri/sdk-core/out';
import { GasInfo } from '@mvx-monorepo/common/utils/gas.info';
import BigNumber from 'bignumber.js';
import { ProxyNetworkProvider } from '@TerraDharitri/sdk-network-providers/out';

@Injectable()
export class WrewaSwapContract {
  constructor(
    private readonly smartContract: SmartContract,
    private readonly resultsParser: ResultsParser,
    private readonly proxy: ProxyNetworkProvider,
  ) {}

  unwrapRewa(token: string, amount: BigNumber, sender: IAddress): Transaction {
    return this.smartContract.methodsExplicit
      .unwrapRewa()
      .withSingleDCDTTransfer(TokenTransfer.fungibleFromBigInteger(token, amount))
      .withGasLimit(GasInfo.UnwrapRewa.value)
      .withSender(sender)
      .buildTransaction();
  }

  async getWrappedRewaTokenId(): Promise<string> {
    const interaction = this.smartContract.methods.getWrappedRewaTokenId([]);
    const query = interaction.check().buildQuery();
    const response = await this.proxy.queryContract(query);

    const { firstValue: tokenId } = this.resultsParser.parseQueryResponse(response, interaction.getEndpoint());

    return tokenId?.valueOf().toString() ?? '';
  }
}
