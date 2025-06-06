import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AccountOnNetwork, ProxyNetworkProvider, TransactionStatus } from '@TerraDharitri/sdk-network-providers/out';
import { MessageApprovedProcessorModule, MessageApprovedProcessorService } from '../src/message-approved-processor';
import { MessageApprovedRepository } from '@mvx-monorepo/common/database/repository/message-approved.repository';
import { PrismaService } from '@mvx-monorepo/common/database/prisma.service';
import { createMock, DeepMocked } from '@golevelup/ts-jest';
import { Transaction, TransactionWatcher } from '@TerraDharitri/sdk-core/out';
import { BinaryUtils } from '@TerraDharitri/sdk-nestjs-common';
import { AbiCoder } from 'ethers';
import { MessageApproved, MessageApprovedStatus } from '@prisma/client';
import { AxelarGmpApi } from '@mvx-monorepo/common';

const WALLET_SIGNER_ADDRESS = 'drt1fsk0cnaag2m78gunfddsvg0y042rf0maxxgz6kvm32kxcl25m0yq6vxy04';

describe('MessageApprovedProcessorService', () => {
  let proxy: DeepMocked<ProxyNetworkProvider>;
  let transactionWatcher: DeepMocked<TransactionWatcher>;
  let axelarGmpApi: DeepMocked<AxelarGmpApi>;
  let prisma: PrismaService;
  let messageApprovedRepository: MessageApprovedRepository;

  let service: MessageApprovedProcessorService;

  let app: INestApplication;

  beforeEach(async () => {
    proxy = createMock();
    transactionWatcher = createMock();
    axelarGmpApi = createMock();

    const moduleRef = await Test.createTestingModule({
      imports: [MessageApprovedProcessorModule],
    })
      .overrideProvider(ProxyNetworkProvider)
      .useValue(proxy)
      .overrideProvider(TransactionWatcher)
      .useValue(transactionWatcher)
      .overrideProvider(AxelarGmpApi)
      .useValue(axelarGmpApi)
      .compile();

    prisma = await moduleRef.get(PrismaService);
    messageApprovedRepository = await moduleRef.get(MessageApprovedRepository);

    service = await moduleRef.get(MessageApprovedProcessorService);

    // Mock general calls
    proxy.getAccount.mockReturnValue(
      Promise.resolve(
        new AccountOnNetwork({
          nonce: 1,
        }),
      ),
    );
    proxy.doPostGeneric.mockImplementation((url: string): Promise<any> => {
      if (url === 'transaction/cost') {
        return Promise.resolve({
          txGasUnits: 10_000_000,
        });
      }

      return Promise.resolve(null);
    });

    proxy.getNetworkConfig.mockImplementation((): Promise<any> => {
      return Promise.resolve({
        MinGasPrice: 1000000000,
        MinGasLimit: 50000,
        GasPerDataByte: 1500,
        GasPriceModifier: 0.01,
      });
    });

    // Reset database & cache
    await prisma.messageApproved.deleteMany();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await prisma.$disconnect();

    await app.close();
  });

  const createMessageApproved = async (extraData: Partial<MessageApproved> = {}): Promise<MessageApproved> => {
    await messageApprovedRepository.createOrUpdate({
      sourceAddress: 'sourceAddress',
      messageId: 'messageId',
      status: MessageApprovedStatus.PENDING,
      sourceChain: 'ethereum',
      contractAddress: 'drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q',
      payloadHash: 'ebc84cbd75ba5516bf45e7024a9e12bc3c5c880f73e3a5beca7ebba52b2867a7',
      payload: Buffer.from('payload'),
      retry: 0,
      executeTxHash: null,
      updatedAt: new Date(),
      createdAt: new Date(),
      availableGasBalance: '0',
      ...extraData,
    });

    // @ts-ignore
    return await prisma.messageApproved.findUnique({
      where: {
        sourceChain_messageId: {
          sourceChain: extraData.sourceChain || 'ethereum',
          messageId: extraData.messageId || 'messageId',
        },
      },
    });
  };

  const assertArgs = (transaction: Transaction, entry: MessageApproved) => {
    const args = transaction.getData().toString().split('@');

    expect(args[0]).toBe('execute');
    expect(args[1]).toBe(BinaryUtils.stringToHex(entry.sourceChain));
    expect(args[2]).toBe(BinaryUtils.stringToHex(entry.messageId));
    expect(args[3]).toBe(BinaryUtils.stringToHex(entry.sourceAddress));
    expect(args[4]).toBe(entry.payload.toString('hex'));
  };

  it('Should send execute transaction two initial', async () => {
    const originalFirstEntry = await createMessageApproved({
      availableGasBalance: '1200000000000000',
    });
    const originalSecondEntry = await createMessageApproved({
      sourceChain: 'polygon',
      messageId: 'messageId2',
      sourceAddress: 'otherSourceAddress',
      payload: Buffer.from('otherPayload'),
      availableGasBalance: '1200000000000000',
    });

    proxy.sendTransactions.mockImplementation((transactions): Promise<string[]> => {
      return Promise.resolve(transactions.map((transaction: any) => transaction.getHash().toString() as string));
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(2);
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

    // Assert transactions data is correct
    const transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
    expect(transactions).toHaveLength(2);

    expect(transactions[0].getGasLimit()).toBe(11_000_000); // 10% over 10_000_000
    expect(transactions[0].getNonce()).toBe(1);
    expect(transactions[0].getChainID()).toBe('test');
    expect(transactions[0].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
    assertArgs(transactions[0], originalFirstEntry);

    expect(transactions[1].getGasLimit()).toBe(11_000_000);
    expect(transactions[1].getNonce()).toBe(2);
    expect(transactions[1].getChainID()).toBe('test');
    expect(transactions[1].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
    assertArgs(transactions[1], originalSecondEntry);

    // No contract call approved pending
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      retry: 1,
      executeTxHash: '8d4112e355c9d2b59e6e80bb552e14fb0f9231e7aea12bf5e15ca59498944e70',
      updatedAt: expect.any(Date),
    });

    const secondEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalSecondEntry.sourceChain,
      originalSecondEntry.messageId,
    );
    expect(secondEntry).toEqual({
      ...originalSecondEntry,
      retry: 1,
      executeTxHash: 'e804e15e143f46003999887ead28642924581381d54f32ba41e386283e59b143',
      updatedAt: expect.any(Date),
    });
  });

  it('Should send execute transaction retry one processed one failed', async () => {
    // Entries will be processed
    const originalFirstEntry = await createMessageApproved({
      retry: 1,
      updatedAt: new Date(new Date().getTime() - 60_500),
      availableGasBalance: '1200000000000000',
    });
    const originalSecondEntry = await createMessageApproved({
      sourceChain: 'polygon',
      messageId: 'messageId2',
      sourceAddress: 'otherSourceAddress',
      payload: Buffer.from('otherPayload'),
      retry: 3,
      updatedAt: new Date(new Date().getTime() - 60_500),
      taskItemId: '0191ead2-2234-7310-b405-76e787415031',
      availableGasBalance: '1200000000000000',
    });
    // Entry will not be processed (updated too early)
    const originalThirdEntry = await createMessageApproved({
      messageId: 'messageId3',
      retry: 1,
      availableGasBalance: '1200000000000000',
    });

    proxy.sendTransactions.mockImplementation((transactions): Promise<string[]> => {
      return Promise.resolve(transactions.map((transaction: any) => transaction.getHash().toString() as string));
    });

    axelarGmpApi.postEvents.mockImplementation(() => {
      return Promise.resolve();
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(1);
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

    // Assert transactions data is correct
    const transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
    expect(transactions).toHaveLength(1);

    expect(transactions[0].getGasLimit()).toBe(13_000_000); // 10% + 20% over 10_000_000
    expect(transactions[0].getNonce()).toBe(1);
    expect(transactions[0].getChainID()).toBe('test');
    expect(transactions[0].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
    assertArgs(transactions[0], originalFirstEntry);

    // No contract call approved pending remained
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      retry: 2,
      executeTxHash: '347a94a760aefcc674c0d13b9405ea2619bef2a326c04695b372f6e7d7df0426',
      updatedAt: expect.any(Date),
    });

    const secondEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalSecondEntry.sourceChain,
      originalSecondEntry.messageId,
    );
    expect(secondEntry).toEqual({
      ...originalSecondEntry,
      status: MessageApprovedStatus.FAILED,
      updatedAt: expect.any(Date),
    });

    expect(axelarGmpApi.postEvents).toHaveBeenCalledTimes(1);
    // @ts-ignore
    expect(axelarGmpApi.postEvents.mock.lastCall[0][0]).toEqual({
      type: 'CANNOT_EXECUTE_MESSAGE/V2',
      eventID: originalSecondEntry?.messageId,
      messageID: originalSecondEntry?.messageId,
      sourcechain: 'dharitri',
      reason: 'ERROR',
      details: 'retried 3 times',
      meta: {
        txID: null,
        taskItemID: originalSecondEntry.taskItemId,
      },
    });

    // Was not updated
    const thirdEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalThirdEntry.sourceChain,
      originalThirdEntry.messageId,
    );
    expect(thirdEntry).toEqual({
      ...originalThirdEntry,
    });
  });

  it('Should send execute transaction not successfully sent', async () => {
    const originalFirstEntry = await createMessageApproved({
      availableGasBalance: '1200000000000000',
    });
    const originalSecondEntry = await createMessageApproved({
      sourceChain: 'polygon',
      messageId: 'messageId2',
      sourceAddress: 'otherSourceAddress',
      payload: Buffer.from('otherPayload'),
      retry: 2,
      updatedAt: new Date(new Date().getTime() - 60_500),
      availableGasBalance: '1200000000000000',
    });

    proxy.sendTransactions.mockImplementation((): Promise<string[]> => {
      return Promise.resolve([]);
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(2);
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

    // Assert transactions data is correct
    const transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
    expect(transactions).toHaveLength(2);

    assertArgs(transactions[0], originalFirstEntry);
    assertArgs(transactions[1], originalSecondEntry);

    // 2 are still pending because of proxy error
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database to NOT be updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      retry: 1, // retry is set to 1
      updatedAt: expect.any(Date),
    });

    const secondEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalSecondEntry.sourceChain,
      originalSecondEntry.messageId,
    );
    expect(secondEntry).toEqual({
      ...originalSecondEntry,
      retry: 2, // retry stays the same
      updatedAt: expect.any(Date),
    });
  });

  function mockProxySendTransactionsSuccess() {
    proxy.sendTransactions.mockImplementation((transactions): Promise<string[]> => {
      return Promise.resolve(transactions.map((transaction: any) => transaction.getHash().toString() as string));
    });
  }

  it('Should send execute transaction do not retry on gas failure', async () => {
    const originalFirstEntry = await createMessageApproved({
      retry: 1,
      updatedAt: new Date(new Date().getTime() - 60_500),
      availableGasBalance: '1200000000000000',
    });

    proxy.sendTransactions.mockImplementation((transactions): Promise<string[]> => {
      return Promise.resolve(transactions.map((transaction: any) => transaction.getHash().toString() as string));
    });
    proxy.doPostGeneric.mockImplementation((): Promise<any> => {
      // Mock gas error
      return Promise.resolve(null);
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(1);
    // Transaction is sent even though it will fail
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

    // No contract call approved pending remained for now
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      executeTxHash: '90d4f525856840a5c9c8115a30e87d823ac8261b298ca4ecb42f1b806fec363c',
      retry: 3,
      updatedAt: expect.any(Date),
    });
  });

  it('Should not send execute transaction if not enough gas', async () => {
    const originalFirstEntry = await createMessageApproved({
      retry: 1,
      updatedAt: new Date(new Date().getTime() - 60_500),
      availableGasBalance: '300000000000000', // Not enough gas
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(1);
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(0);

    // No contract call approved pending remained for now
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      status: 'FAILED',
      retry: 3,
      updatedAt: expect.any(Date),
    });

    expect(axelarGmpApi.postEvents).toHaveBeenCalledTimes(1);
    // @ts-ignore
    expect(axelarGmpApi.postEvents.mock.lastCall[0][0]).toEqual({
      type: 'CANNOT_EXECUTE_MESSAGE/V2',
      eventID: firstEntry?.messageId,
      messageID: firstEntry?.messageId,
      sourcechain: 'dharitri',
      reason: 'INSUFFICIENT_GAS',
      details: 'retried 3 times',
      meta: {
        txID: null,
        taskItemID: '',
      },
    });
  });

  it('Should not send execute transaction if not enough gas negative', async () => {
    const originalFirstEntry = await createMessageApproved({
      retry: 1,
      updatedAt: new Date(new Date().getTime() - 60_500),
      availableGasBalance: '-300000000000000', // Not enough gas negative
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(1);
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(0);

    // No contract call approved pending remained for now
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      status: 'FAILED',
      retry: 3,
      updatedAt: expect.any(Date),
    });
  });

  describe('ITS execute', () => {
    const contractAddress = 'drt1qqqqqqqqqqqqqpgq97wezxw6l7lgg7k9rxvycrz66vn92ksh2tssmj7a6l';

    it('Should send execute transaction one deploy interchain token one other', async () => {
      const originalItsExecuteOther = await createMessageApproved({
        contractAddress,
        payload: Buffer.from(AbiCoder.defaultAbiCoder().encode(['uint256'], [0]).substring(2), 'hex'),
        availableGasBalance: '1200000000000000',
      });
      const originalItsExecute = await createMessageApproved({
        contractAddress,
        sourceChain: 'polygon',
        sourceAddress: 'otherSourceAddress',
        payload: Buffer.from(AbiCoder.defaultAbiCoder().encode(['uint256'], [1]).substring(2), 'hex'),
        availableGasBalance: '1200000000000000',
      });

      mockProxySendTransactionsSuccess();

      await service.processPendingMessageApproved();

      expect(proxy.getAccount).toHaveBeenCalledTimes(1);
      expect(proxy.doPostGeneric).toHaveBeenCalledTimes(2);
      expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

      // Assert transactions data is correct
      const transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(2);

      expect(transactions[0].getGasLimit()).toBe(11_000_000); // 10% over 10_000_000
      expect(transactions[0].getNonce()).toBe(1);
      expect(transactions[0].getChainID()).toBe('test');
      expect(transactions[0].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
      assertArgs(transactions[0], originalItsExecuteOther);
      expect(transactions[0].getValue()).toBe(0n); // assert sent with value 0

      expect(transactions[1].getGasLimit()).toBe(11_000_000);
      expect(transactions[1].getNonce()).toBe(2);
      expect(transactions[1].getChainID()).toBe('test');
      expect(transactions[1].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
      assertArgs(transactions[1], originalItsExecute);
      expect(transactions[1].getValue()).toBe(0n); // assert sent with value 0

      // No contract call approved pending
      expect(await messageApprovedRepository.findPending()).toEqual([]);

      // Expect entries in database updated
      const itsExecuteOther = await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecuteOther.sourceChain,
        originalItsExecuteOther.messageId,
      );
      expect(itsExecuteOther).toEqual({
        ...originalItsExecuteOther,
        retry: 1,
        executeTxHash: 'bf98d80b5850d39de84f3bcf128badf49546b0f03e366d9fe89b0bd321942619',
        updatedAt: expect.any(Date),
        successTimes: null,
      });

      const itsExecute = await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      );
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 1,
        executeTxHash: '0d3703be6d54ce8610ac8869a85f90eb7feef5258a4258b3b441af526084ec98',
        updatedAt: expect.any(Date),
        successTimes: null,
      });
    });

    it('Should send execute transaction deploy interchain token 2 times', async () => {
      const originalItsExecute = await createMessageApproved({
        contractAddress,
        sourceChain: 'polygon',
        sourceAddress: 'otherSourceAddress',
        payload: Buffer.from(AbiCoder.defaultAbiCoder().encode(['uint256'], [1]).substring(2), 'hex'),
        availableGasBalance: '51200000000000000', // also contains 0.05 REWA for DCDT issue
      });

      mockProxySendTransactionsSuccess();

      await service.processPendingMessageApproved();

      expect(proxy.getAccount).toHaveBeenCalledTimes(1);
      expect(proxy.doPostGeneric).toHaveBeenCalledTimes(1);
      expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

      // Assert transactions data is correct
      let transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(1);

      expect(transactions[0].getGasLimit()).toBe(11_000_000);
      expect(transactions[0].getNonce()).toBe(1);
      expect(transactions[0].getChainID()).toBe('test');
      expect(transactions[0].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
      assertArgs(transactions[0], originalItsExecute);
      expect(transactions[0].getValue()).toBe(0n); // assert sent with no value 1st time

      // No contract call approved pending
      expect(await messageApprovedRepository.findPending()).toEqual([]);

      // @ts-ignore
      let itsExecute: MessageApproved = await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      );
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 1,
        executeTxHash: '67b2b814e2ec9bdd08f57073f575ec95d160c76ec9ccd4d14395e7824b6b77cc',
        updatedAt: expect.any(Date),
        successTimes: null,
      });

      // Mark as last updated more than 1 minute ago
      itsExecute.updatedAt = new Date(new Date().getTime() - 60_500);
      await prisma.messageApproved.update({
        where: {
          sourceChain_messageId: {
            sourceChain: itsExecute.sourceChain,
            messageId: itsExecute.messageId,
          },
        },
        data: itsExecute,
      });

      // Mock 1st transaction executed successfully
      transactionWatcher.awaitCompleted.mockReturnValueOnce(
        // @ts-ignore
        Promise.resolve({
          ...transactions[0],
          status: new TransactionStatus('success'),
        }),
      );

      // Process transaction 2nd time
      await service.processPendingMessageApproved();

      transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(1);
      expect(transactions[0].getValue()).toBe(50000000000000000n); // assert sent with value 2nd time

      itsExecute = (await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      )) as MessageApproved;
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 2,
        executeTxHash: 'e51db2e016b546d937c204725e3ecef6d725dec3049695de1e92419e0536ea4d',
        updatedAt: expect.any(Date),
        successTimes: 1,
      });

      // Mark as last updated more than 1 minute ago
      itsExecute.updatedAt = new Date(new Date().getTime() - 60_500);
      await prisma.messageApproved.update({
        where: {
          sourceChain_messageId: {
            sourceChain: itsExecute.sourceChain,
            messageId: itsExecute.messageId,
          },
        },
        data: itsExecute,
      });

      // Process transaction 3rd time will retry transaction not sent
      proxy.sendTransactions.mockReturnValueOnce(Promise.resolve([]));

      await service.processPendingMessageApproved();

      transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(1);
      expect(transactions[0].getValue()).toBe(50000000000000000n); // assert sent with value

      itsExecute = (await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      )) as MessageApproved;
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 2,
        executeTxHash: null,
        updatedAt: expect.any(Date),
        successTimes: 1,
      });

      // Mark as last updated more than 1 minute ago
      itsExecute.updatedAt = new Date(new Date().getTime() - 60_500);
      await prisma.messageApproved.update({
        where: {
          sourceChain_messageId: {
            sourceChain: itsExecute.sourceChain,
            messageId: itsExecute.messageId,
          },
        },
        data: itsExecute,
      });

      // Process transaction 3rd time will retry transaction sent
      mockProxySendTransactionsSuccess();

      await service.processPendingMessageApproved();

      transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(1);
      expect(transactions[0].getValue()).toBe(50000000000000000n); // assert sent with value

      itsExecute = (await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      )) as MessageApproved;
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 3,
        executeTxHash: 'ef05047f045cc3769eaa31130ce1efa4c558367df7920327b57d9350ed123dfd',
        updatedAt: expect.any(Date),
        successTimes: 1,
      });
    });

    it('Should send execute transaction deploy interchain token ITS Hub payload', async () => {
      const originalItsExecute = await createMessageApproved({
        contractAddress,
        sourceChain: 'polygon',
        sourceAddress: 'otherSourceAddress',
        payload: Buffer.from(
          AbiCoder.defaultAbiCoder()
            .encode(
              ['uint256', 'string', 'bytes'],
              [4, 'ethereum', AbiCoder.defaultAbiCoder().encode(['uint256'], [1])],
            )
            .substring(2),
          'hex',
        ),
        availableGasBalance: '51200000000000000', // also contains 0.05 REWA for DCDT issue
        executeTxHash: '67b2b814e2ec9bdd08f57073f575ec95d160c76ec9ccd4d14395e7824b6b77cc',
        successTimes: 1,
      });

      // Mock 1st transaction executed successfully
      transactionWatcher.awaitCompleted.mockReturnValueOnce(
        // @ts-ignore
        Promise.resolve({
          status: new TransactionStatus('success'),
        }),
      );

      mockProxySendTransactionsSuccess();

      await service.processPendingMessageApproved();

      const transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(1);
      expect(transactions[0].getValue()).toBe(50000000000000000n); // assert sent with value

      const itsExecute = (await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      )) as MessageApproved;
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 1,
        executeTxHash: '73887b17192ededfda3318bc824e0ea0594dd3b7b7e7251dadde36ca8dbaea17',
        updatedAt: expect.any(Date),
        successTimes: 1,
      });
    });

    it('Should send execute transaction deploy interchain token only deploy dcdt not enough fee', async () => {
      const originalItsExecute = await createMessageApproved({
        contractAddress,
        sourceChain: 'polygon',
        sourceAddress: 'otherSourceAddress',
        payload: Buffer.from(AbiCoder.defaultAbiCoder().encode(['uint256'], [1]).substring(2), 'hex'),
        retry: 1,
        executeTxHash: '67b2b814e2ec9bdd08f57073f575ec95d160c76ec9ccd4d14395e7824b6b77cc',
        successTimes: 1,
        availableGasBalance: '1200000000000000', // not enough fee for paying 0.05 REWA for DCDT issue
        updatedAt: new Date(new Date().getTime() - 60_500),
      });

      // Process transaction for DCDT issue only
      await service.processPendingMessageApproved();

      expect(proxy.sendTransactions).toHaveBeenCalledTimes(0);

      const itsExecute = (await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      )) as MessageApproved;
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 3,
        status: 'FAILED',
        updatedAt: expect.any(Date),
      });
    });
  });
});
