import { Hash } from '@hyper-hyper-space/core';


interface LedgerLike {

    getHeadBlockHash(): Hash|undefined;
    getHeadBlockNumber(): bigint;

    getBalance(address: Hash): bigint;
    wasApplied(tx: Hash): boolean;
}

export { LedgerLike }