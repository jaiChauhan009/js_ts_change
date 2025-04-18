import { Constants } from "@TerraDharitri/sdk-nestjs-common";

export class CacheInfo {
  key: string = "";
  ttl: number = Constants.oneSecond() * 6;

  static PendingTransaction(hash: string): CacheInfo {
    return {
      key: `pendingTransaction:${hash}`,
      ttl: Constants.oneMinute() * 10,
    };
  }

  static WrewaTokenId(): CacheInfo {
    return {
      key: `wrewaTokenId`,
      ttl: Constants.oneWeek(),
    };
  }

  static CrossChainTransactions(): CacheInfo {
    return {
      key: `crossChainTransactions`,
      ttl: Constants.oneWeek(),
    };
  }
}
