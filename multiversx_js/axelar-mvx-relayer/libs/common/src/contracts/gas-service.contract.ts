import {
  AbiRegistry,
  BigUIntValue,
  IAddress,
  ITransactionEvent,
  SmartContract,
  StringValue,
  Transaction,
  VariadicValue,
} from '@TerraDharitri/sdk-core/out';
import { Injectable } from '@nestjs/common';
import { Events } from '../utils/event.enum';
import {
  GasAddedEvent,
  GasPaidForContractCallEvent,
  RefundedEvent,
} from '@mvx-monorepo/common/contracts/entities/gas-service-events';
import { CONSTANTS } from '@mvx-monorepo/common/utils/constants.enum';
import { DecodingUtils } from '@mvx-monorepo/common/utils/decoding.utils';
import BigNumber from 'bignumber.js';
import { GasInfo } from '@mvx-monorepo/common/utils/gas.info';

@Injectable()
export class GasServiceContract {
  constructor(
    private readonly smartContract: SmartContract,
    private readonly abi: AbiRegistry,
  ) {}

  collectFees(sender: IAddress, tokens: string[], amounts: BigNumber[]): Transaction {
    return this.smartContract.methods
      .collectFees([
        sender.bech32(),
        VariadicValue.fromItemsCounted(...tokens.map((token) => new StringValue(token))),
        VariadicValue.fromItemsCounted(...amounts.map((amount) => new BigUIntValue(amount))),
      ])
      .withGasLimit(GasInfo.CollectFeesBase.value + GasInfo.CollectFeesExtra.value * tokens.length)
      .withSender(sender)
      .buildTransaction();
  }

  refund(
    sender: IAddress,
    txHash: string,
    logIndex: string,
    receiver: string,
    token: string,
    amount: string,
  ): Transaction {
    return this.smartContract.methods
      .refund([Buffer.from(txHash, 'hex'), logIndex, receiver, token, amount])
      .withGasLimit(GasInfo.Refund.value)
      .withSender(sender)
      .buildTransaction();
  }

  decodeGasPaidForContractCallEvent(event: ITransactionEvent): GasPaidForContractCallEvent {
    const eventDefinition = this.abi.getEvent(Events.GAS_PAID_FOR_CONTRACT_CALL_EVENT);
    const outcome = DecodingUtils.parseTransactionEvent(event, eventDefinition);

    return {
      sender: outcome.sender,
      destinationChain: outcome.destination_chain.toString(),
      destinationAddress: outcome.destination_contract_address.toString(),
      data: {
        payloadHash: DecodingUtils.decodeByteArrayToHex(outcome.data.hash),
        gasToken: outcome.data.gas_token.toString(),
        gasFeeAmount: outcome.data.gas_fee_amount,
        refundAddress: outcome.data.refund_address,
      },
    };
  }

  decodeNativeGasPaidForContractCallEvent(event: ITransactionEvent): GasPaidForContractCallEvent {
    const eventDefinition = this.abi.getEvent(Events.NATIVE_GAS_PAID_FOR_CONTRACT_CALL_EVENT);
    const outcome = DecodingUtils.parseTransactionEvent(event, eventDefinition);

    return {
      sender: outcome.sender,
      destinationChain: outcome.destination_chain.toString(),
      destinationAddress: outcome.destination_contract_address.toString(),
      data: {
        payloadHash: DecodingUtils.decodeByteArrayToHex(outcome.data.hash),
        gasToken: null,
        gasFeeAmount: outcome.data.value,
        refundAddress: outcome.data.refund_address,
      },
    };
  }

  decodeGasAddedEvent(event: ITransactionEvent): GasAddedEvent {
    const eventDefinition = this.abi.getEvent(Events.GAS_ADDED_EVENT);
    const outcome = DecodingUtils.parseTransactionEvent(event, eventDefinition);

    return {
      txHash: outcome.tx_hash.toString('hex'),
      logIndex: outcome.log_index.toNumber(),
      data: {
        gasToken: outcome.data.gas_token.toString(),
        gasFeeAmount: outcome.data.gas_fee_amount,
        refundAddress: outcome.data.refund_address,
      },
    };
  }

  decodeNativeGasAddedEvent(event: ITransactionEvent): GasAddedEvent {
    const eventDefinition = this.abi.getEvent(Events.NATIVE_GAS_ADDED_EVENT);
    const outcome = DecodingUtils.parseTransactionEvent(event, eventDefinition);

    return {
      txHash: outcome.tx_hash.toString('hex'),
      logIndex: outcome.log_index.toNumber(),
      data: {
        gasToken: null,
        gasFeeAmount: outcome.data.value,
        refundAddress: outcome.data.refund_address,
      },
    };
  }

  decodeRefundedEvent(event: ITransactionEvent): RefundedEvent {
    const eventDefinition = this.abi.getEvent(Events.REFUNDED_EVENT);
    const outcome = DecodingUtils.parseTransactionEvent(event, eventDefinition);

    const token = outcome.data.token.toString();

    return {
      txHash: outcome.tx_hash.toString('hex'),
      logIndex: outcome.log_index.toNumber(),
      data: {
        receiver: outcome.data.receiver,
        token: token === CONSTANTS.REWA_IDENTIFIER ? null : token,
        amount: outcome.data.amount,
      },
    };
  }

  getContractAddress(): IAddress {
    return this.smartContract.getAddress();
  }
}
