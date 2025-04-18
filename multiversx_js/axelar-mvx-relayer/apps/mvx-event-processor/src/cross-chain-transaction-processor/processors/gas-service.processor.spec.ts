import { Test, TestingModule } from '@nestjs/testing';
import { GasServiceProcessor } from './gas-service.processor';
import { createMock, DeepMocked } from '@golevelup/ts-jest';
import { GasServiceContract } from '@mvx-monorepo/common/contracts/gas-service.contract';
import { BinaryUtils } from '@TerraDharitri/sdk-nestjs-common';
import { EventIdentifiers, Events } from '@mvx-monorepo/common/utils/event.enum';
import { Address, ITransactionEvent } from '@TerraDharitri/sdk-core/out';
import { ApiConfigService, GatewayContract } from '@mvx-monorepo/common';
import { TransactionEvent, TransactionOnNetwork } from '@TerraDharitri/sdk-network-providers/out';
import {
  GasAddedEvent,
  GasPaidForContractCallEvent,
  RefundedEvent,
} from '@mvx-monorepo/common/contracts/entities/gas-service-events';
import BigNumber from 'bignumber.js';
import { Components, GasRefundedEvent } from '@mvx-monorepo/common/api/entities/axelar.gmp.api';
import { ContractCallEvent } from '@mvx-monorepo/common/contracts/entities/gateway-events';
import GasCreditEvent = Components.Schemas.GasCreditEvent;

const mockGasServiceContract = 'drt1yvesqqqqqqqqqqqqqqqqqqqqqqqqyvesqqqqqqqqqqqqqqqplllsphc9lf';
const mockGatewayContract = 'drt1qqqqqqqqqqqqqpgqvc7gdl0p4s97guh498wgz75k8sav6sjfjlwq2xfx36';

describe('GasServiceProcessor', () => {
  let gasServiceContract: DeepMocked<GasServiceContract>;
  let gatewayContract: DeepMocked<GatewayContract>;
  let apiConfigService: DeepMocked<ApiConfigService>;

  let service: GasServiceProcessor;

  beforeEach(async () => {
    gasServiceContract = createMock();
    gatewayContract = createMock();
    apiConfigService = createMock();

    apiConfigService.getContractGateway.mockReturnValue(mockGatewayContract);

    const module: TestingModule = await Test.createTestingModule({
      providers: [GasServiceProcessor],
    })
      .useMocker((token) => {
        if (token === GasServiceContract) {
          return gasServiceContract;
        }

        if (token === GatewayContract) {
          return gatewayContract;
        }

        if (token === ApiConfigService) {
          return apiConfigService;
        }

        return null;
      })
      .compile();

    service = module.get<GasServiceProcessor>(GasServiceProcessor);
  });

  it('Should not handle event', () => {
    const rawEvent: ITransactionEvent = TransactionEvent.fromHttpResponse({
      address: 'drt1yvesqqqqqqqqqqqqqqqqqqqqqqqqyvesqqqqqqqqqqqqqqqplllsphc9lf',
      identifier: 'callContract',
      data: '',
      topics: [BinaryUtils.base64Encode(Events.CONTRACT_CALL_EVENT)],
    });

    const result = service.handleGasServiceEvent(rawEvent, createMock(), 0, '100');

    expect(result).toBeUndefined();
    expect(gasServiceContract.decodeGasPaidForContractCallEvent).not.toHaveBeenCalled();
    expect(gasServiceContract.decodeNativeGasPaidForContractCallEvent).not.toHaveBeenCalled();
    expect(gasServiceContract.decodeGasAddedEvent).not.toHaveBeenCalled();
    expect(gasServiceContract.decodeNativeGasAddedEvent).not.toHaveBeenCalled();
    expect(gasServiceContract.decodeRefundedEvent).not.toHaveBeenCalled();
  });

  const getMockGasPaid = (
    eventName: string = Events.GAS_PAID_FOR_CONTRACT_CALL_EVENT,
    gasToken: string | null = 'WREWA-123456',
  ) => {
    const rawEvent = TransactionEvent.fromHttpResponse({
      address: mockGasServiceContract,
      identifier: 'any',
      data: '',
      topics: [BinaryUtils.base64Encode(eventName)],
    });

    const event: GasPaidForContractCallEvent = {
      sender: Address.newFromBech32('drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q'),
      destinationChain: 'ethereum',
      destinationAddress: 'destinationAddress',
      data: {
        payloadHash: 'ebc84cbd75ba5516bf45e7024a9e12bc3c5c880f73e3a5beca7ebba52b2867a7',
        gasToken,
        gasFeeAmount: new BigNumber('654321'),
        refundAddress: Address.newFromBech32('drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q'),
      },
    };

    return { rawEvent, event };
  };

  const contractCallEvent: ContractCallEvent = {
    sender: Address.fromBech32('drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q'),
    destinationChain: 'ethereum',
    destinationAddress: 'destinationAddress',
    payloadHash: 'ebc84cbd75ba5516bf45e7024a9e12bc3c5c880f73e3a5beca7ebba52b2867a7',
    payload: Buffer.from('payload'),
  };

  function assertEventGasPaidForContractCall(
    rawEvent: TransactionEvent,
    isValid = true,
    tokenID: string | null = 'WREWA-123456',
  ) {
    const transaction = createMock<TransactionOnNetwork>();
    transaction.hash = 'txHash';

    if (isValid) {
      transaction.logs.events = [
        rawEvent,
        TransactionEvent.fromHttpResponse({
          address: mockGatewayContract,
          identifier: EventIdentifiers.CALL_CONTRACT,
          data: contractCallEvent.payload.toString('base64'),
          topics: [
            BinaryUtils.base64Encode(Events.CONTRACT_CALL_EVENT),
            Buffer.from((contractCallEvent.sender as Address).hex(), 'hex').toString('base64'),
            BinaryUtils.base64Encode(contractCallEvent.destinationChain),
            BinaryUtils.base64Encode(contractCallEvent.destinationAddress),
            Buffer.from(contractCallEvent.payloadHash, 'hex').toString('base64'),
          ],
        }),
      ];
    } else {
      transaction.logs.events = [];
    }

    const result = service.handleGasServiceEvent(rawEvent, transaction, 0, '100');

    if (!isValid) {
      expect(result).toBeUndefined();

      return;
    }

    expect(result).not.toBeUndefined();
    expect(result?.type).toBe('GAS_CREDIT');

    const event = result as GasCreditEvent;

    expect(event.eventID).toBe('0xtxHash-0');
    expect(event.messageID).toBe('0xtxHash-1');
    expect(event.refundAddress).toBe('drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q');
    expect(event.payment).toEqual({
      tokenID,
      amount: '654321',
    });
    expect(event.meta).toEqual({
      txID: 'txHash',
      fromAddress: 'drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q',
      finalized: true,
    });
  }

  describe('Handle event gas paid for contract call', () => {
    const { rawEvent, event } = getMockGasPaid();

    it('Should handle', () => {
      gasServiceContract.decodeGasPaidForContractCallEvent.mockReturnValueOnce(event);
      gatewayContract.decodeContractCallEvent.mockReturnValueOnce(contractCallEvent);

      assertEventGasPaidForContractCall(rawEvent);
    });

    it('Should not handle if contract call event not found', () => {
      gasServiceContract.decodeGasPaidForContractCallEvent.mockReturnValueOnce(event);

      assertEventGasPaidForContractCall(rawEvent, false);
    });
  });

  describe('Handle event native gas paid for contract call', () => {
    const { rawEvent, event } = getMockGasPaid(Events.NATIVE_GAS_PAID_FOR_CONTRACT_CALL_EVENT, null);

    it('Should handle', () => {
      gasServiceContract.decodeNativeGasPaidForContractCallEvent.mockReturnValueOnce(event);
      gatewayContract.decodeContractCallEvent.mockReturnValueOnce(contractCallEvent);

      assertEventGasPaidForContractCall(rawEvent, true, null);
    });

    it('Should not handle if contract call event not found', () => {
      gasServiceContract.decodeNativeGasPaidForContractCallEvent.mockReturnValueOnce(event);

      assertEventGasPaidForContractCall(rawEvent, false);
    });
  });

  const getMockGasAdded = (eventName: string = Events.GAS_ADDED_EVENT, gasToken: string | null = 'WREWA-123456') => {
    const rawEvent: TransactionEvent = TransactionEvent.fromHttpResponse({
      address: mockGasServiceContract,
      identifier: 'any',
      data: '',
      topics: [BinaryUtils.base64Encode(eventName)],
    });

    const event: GasAddedEvent = {
      txHash: 'txHash',
      logIndex: 1,
      data: {
        gasToken,
        gasFeeAmount: new BigNumber('1000'),
        refundAddress: Address.fromBech32('drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q'),
      },
    };

    return { rawEvent, event };
  };

  function assertGasAddedEvent(rawEvent: TransactionEvent, tokenID: string | null = 'WREWA-123456') {
    const transaction = createMock<TransactionOnNetwork>();
    transaction.hash = 'txHash';
    transaction.sender = Address.fromBech32('drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q');

    const result = service.handleGasServiceEvent(rawEvent, transaction, 0, '100');

    expect(result).not.toBeUndefined();
    expect(result?.type).toBe('GAS_CREDIT');

    const event = result as GasCreditEvent;

    expect(event.eventID).toBe('0xtxHash-0');
    expect(event.messageID).toBe('0xtxHash-1');
    expect(event.refundAddress).toBe('drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q');
    expect(event.payment).toEqual({
      tokenID,
      amount: '1000',
    });
    expect(event.meta).toEqual({
      txID: 'txHash',
      fromAddress: 'drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q',
      finalized: true,
    });
  }

  describe('Handle event gas added', () => {
    const { rawEvent, event } = getMockGasAdded();

    it('Should handle', () => {
      gasServiceContract.decodeGasAddedEvent.mockReturnValueOnce(event);

      assertGasAddedEvent(rawEvent);
    });
  });

  describe('Handle event native gas added', () => {
    const { rawEvent, event } = getMockGasAdded(Events.NATIVE_GAS_ADDED_EVENT, null);

    it('Should handle', () => {
      gasServiceContract.decodeNativeGasAddedEvent.mockReturnValueOnce(event);

      assertGasAddedEvent(rawEvent, null);
    });
  });

  describe('Handle event refunded', () => {
    const rawEvent: TransactionEvent = TransactionEvent.fromHttpResponse({
      address: mockGasServiceContract,
      identifier: 'any',
      data: '',
      topics: [BinaryUtils.base64Encode(Events.REFUNDED_EVENT)],
    });

    const refundedEvent: RefundedEvent = {
      txHash: 'txHash',
      logIndex: 1,
      data: {
        token: null,
        amount: new BigNumber('500'),
        receiver: Address.fromBech32('drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q'),
      },
    };

    it('Should handle', () => {
      gasServiceContract.decodeRefundedEvent.mockReturnValueOnce(refundedEvent);

      const transaction = createMock<TransactionOnNetwork>();
      transaction.hash = 'txHash';
      transaction.sender = Address.fromBech32('drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q');

      const result = service.handleGasServiceEvent(rawEvent, transaction, 0, '100');

      expect(result).not.toBeUndefined();
      expect(result?.type).toBe('GAS_REFUNDED');

      const event = result as GasRefundedEvent;

      expect(event.eventID).toBe('0xtxHash-0');
      expect(event.messageID).toBe('0xtxHash-1');
      expect(event.recipientAddress).toBe('drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q');
      expect(event.refundedAmount).toEqual({
        tokenID: null,
        amount: '500',
      });
      expect(event.cost).toEqual({
        amount: '100',
      });
      expect(event.meta).toEqual({
        txID: 'txHash',
        fromAddress: 'drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q',
        finalized: true,
      });
    });
  });
});
