
//import {createHash} from "crypto";
import { Hash, HashedObject, Hashing, MutationOp } from '@hyper-hyper-space/core';
import { HashedBigInt } from './HashedBigInt';
//import { Logger, LogLevel } from '@hyper-hyper-space/core';

import { Blockchain } from './Blockchain';
import { MiniComptroller, FixedPoint } from './MiniComptroller';
//import { VDF } from './VDF';

//import {SlothPermutation} from '@hyper-hyper-space/sloth-permutation';
import {SlothPermutation} from './SlothVDF';
(global as any).document = { }; // yikes!

class BlockchainValueOp extends MutationOp {

    //static log = new Logger(BlockchainValueOp.name, LogLevel.TRACE)

    static className = 'hhs/v0/soliton/BlockchainValueOp';

    static vdfInit = async () => {
        BlockchainValueOp.vdfVerifier = new SlothPermutation();
        BlockchainValueOp.comptroller = new MiniComptroller();
    };
    static vdfVerifier: any;
    static comptroller: any;
    static coins: bigint = BigInt(0);
    static totalCoins: bigint = MiniComptroller.bootstrapVirtualStake * BigInt(2);

    vdfResult?: string;
    vdfBootstrapResult?: string;
    
    blockNumber?: HashedBigInt;
    movingMaxSpeed?: HashedBigInt;
    movingMinSpeed?: HashedBigInt;
    blockTimeFactor?: HashedBigInt;

    timestampSeconds?: number; 

    constructor(target?: Blockchain, prevOp?: BlockchainValueOp, vdfResult?: string, vdfBoostrapResult?: string) {
        super(target);

        if (target !== undefined && vdfResult !== undefined && vdfBoostrapResult !== undefined) {

            this.timestampSeconds = Date.now();

            let blocktime = prevOp !== undefined? 
                                BigInt(Math.floor(this.timestampSeconds - (prevOp.timestampSeconds as number))) * (FixedPoint.UNIT / (BigInt(10)**BigInt(3)))
                            :
                                MiniComptroller.targetBlockTime; // FIXME: initial block time
            // TODO: use milliseconds
            if (blocktime == BigInt(0))
                blocktime = BigInt(1) * FixedPoint.UNIT
            console.log('Verifying block with blockTime (secs) = ', Number(blocktime) / Number(FixedPoint.UNIT) )
            const comp = BlockchainValueOp.initializeComptroller(prevOp);

            const challenge = BlockchainValueOp.getChallenge((this.getTarget() as Blockchain), prevOp?.hash());
            console.log('Challenge length (bytes) = ', challenge.length / 2 )
            // TODO: warning! replace with VRF seed + hashing with prev block hash.
            const steps = BlockchainValueOp.getVDFSteps(comp, challenge)

            comp.addBlockSample(blocktime, steps);

            this.blockNumber = new HashedBigInt(comp.getBlockNumber());
            this.movingMaxSpeed = new HashedBigInt(comp.getMovingMaxSpeed());
            this.movingMinSpeed = new HashedBigInt(comp.getMovingMinSpeed());
            this.blockTimeFactor = new HashedBigInt(comp.getBlockTimeFactor());
        }

    }

    getClassName(): string {
        return BlockchainValueOp.className;
    }

    init(): void {
        
    }

    async validate(references: Map<Hash, HashedObject>): Promise<boolean> {

        if (this.blockNumber === undefined || this.vdfResult === undefined || this.vdfBootstrapResult === undefined) {
            console.log('Object is incomplete.');
            return false;
        }

        if (this.blockNumber.getValue() < BigInt(0)) {
            console.log('Sequence number is negative.');
            return false;
        }

        if (this.timestampSeconds === undefined) {
            console.log('Missing timestamp');
            return false;
        }

        if (!super.validate(references)) {
            console.log('Generic op validation failed.');
            return false;
        }

        if (! (this.getTarget() instanceof Blockchain)) {
            console.log('Target is nt a Blockchain instance.');
            return false;
        }

        if (this.getAuthor() !== undefined) {
            console.log('Author is not undefined as it should be.');
            return false;
        }

        if (this.prevOps === undefined) {
            console.log('PrevOps is missing (it should be empty or a singleton - not missing).');
            return false;
        }

        let prev: HashedObject | undefined = undefined;
        
        if (this.prevOps.size() > 0) {

            if (this.prevOps.size() !== 1) {
                console.log('PrevOps size is not 0 or 1.');
                return false;
            }

            prev = references.get(this.prevOps.values().next().value.hash);

            if (!(prev instanceof BlockchainValueOp)) {
                console.log('prevOP is not an instance of BlockchainValueOp.');
                return false;
            }

            if (!prev.getTarget().equals(this.getTarget())) {
                console.log('The prevOp and this op targets differ.');
                return false;
            }
        }

        const prevOp: BlockchainValueOp | undefined = prev;
            
        const blocktime = prevOp !== undefined? 
                                BigInt((this.timestampSeconds as number) - (prevOp.timestampSeconds as number))
                            :
                                MiniComptroller.targetBlockTime; // FIXME: initial block time
                        
        const comp = BlockchainValueOp.initializeComptroller(prev);

        if (!comp.updateOrTestBlockTimeActionable(blocktime)) {
            console.log('Comptroller rejected blockTimeFactor');
            return false;
        }

        if (!comp.updateOrTestSpeedRatioTarget(this.movingMaxSpeed?.getValue(), this.movingMinSpeed?.getValue())) {
            console.log('Comptroller rejected movingMaxSpeed/movingMinSpeed');
            return false;
        }

        if (this.vdfResult.toUpperCase() !== this.vdfResult) {
            console.log('VDF result is not uppercase');
            return false;
        }

        if (this.vdfBootstrapResult.toUpperCase() !== this.vdfBootstrapResult) {
            console.log('VDF boostrap result is not uppercase');
            return false;
        }

        if ((this.vdfBootstrapResult !== '') === comp.isBootstrapPeriod()) {
            console.log('VDF boostrap result is only empty when boostrap period ended.');
            return false;
        }

        const challenge = BlockchainValueOp.getChallenge((this.getTarget() as Blockchain), prevOp?.hash());
        let challengeBuffer = Buffer.from(challenge, 'hex');
        console.log('Bootstrap Challenge length (bytes) = ', challengeBuffer.length)
        const challenge256bits = Buffer.concat([challengeBuffer,challengeBuffer])
        
        // Boostrap period Protection check
        // In boostrap period do a pre-VDF with 50% blockTime.
        if (comp.isBootstrapPeriod()) {
            const resultBoostrapBuffer = Buffer.from(this.vdfBootstrapResult, 'hex');
            const boostrapSteps = comp.getConsensusBoostrapDifficulty()
            if (!BlockchainValueOp.vdfVerifier.verifyBufferProofVDF(Number(boostrapSteps), challenge256bits, resultBoostrapBuffer)) {
                console.log('Boostrap VDF verification failed.');
                return false;
            }
            challengeBuffer = resultBoostrapBuffer;
        }

        const resultBuffer = Buffer.from(this.vdfResult, 'hex');
        console.log('Result proof length (bytes) = ', this.vdfResult.length)
        const steps = BlockchainValueOp.getVDFSteps(comp, challenge)
        if (!BlockchainValueOp.vdfVerifier.verifyBufferProofVDF(Number(steps), challenge256bits, resultBuffer)) {
            console.log('VDF verification failed.');
            return false;
        }

        console.log('Successfully received proof for sequence number ' + this.blockNumber + '.');

        return true;

    }

    static getChallenge(target: Blockchain, prevOpHash?: Hash) {
        let challenge: string;

        if (prevOpHash === undefined) {
            challenge = target.getInitialChallenge();
        } else {
            challenge = Hashing.sha.sha256hex(prevOpHash);
        }

        return challenge //.slice(0,challenge.length/2);
    }

    static getVDFSteps(comp: MiniComptroller, challenge: string) {
        // TODO: warning! using the challenge as temporary VRF seed. Replace this with VRF seed hashed with prev hash block!
        const seedVRF = BigInt( '0x'+challenge ) // TODO: warning! replace with VRF seed + hashing with prev block hash.
        const steps = comp.getConsensusDifficulty(
                                            BlockchainValueOp.coins,
                                            BlockchainValueOp.totalCoins,
                                            seedVRF,
                                        );
        return steps;
    }

    static initializeComptroller(prevOp?: BlockchainValueOp): MiniComptroller {
        const comptroller = new MiniComptroller();

        if (prevOp !== undefined) {
            comptroller.setBlockNumber(prevOp.blockNumber?.getValue() as bigint);
            comptroller.setMovingMaxSpeed(prevOp.movingMaxSpeed?.getValue() as bigint);
            comptroller.setMovingMinSpeed(prevOp.movingMinSpeed?.getValue() as bigint);
            comptroller.setBlockTimeFactor(prevOp.blockTimeFactor?.getValue() as bigint);
            comptroller.setSpeedRatio(FixedPoint.divTrunc(comptroller.getMovingMaxSpeed(), comptroller.getMovingMinSpeed()));
        } else {
            comptroller.setBlockTimeFactor(BigInt(20000) * FixedPoint.UNIT)
            comptroller.setMovingMaxSpeed(BigInt(750) * FixedPoint.UNIT);
            comptroller.setMovingMinSpeed(BigInt(500) * FixedPoint.UNIT);
            comptroller.setSpeedRatio(FixedPoint.divTrunc(comptroller.getMovingMaxSpeed(), comptroller.getMovingMinSpeed()));
        }

        comptroller.setMaxSpeedRatio(BigInt(4) * FixedPoint.UNIT);

        return comptroller;

    }

}

HashedObject.registerClass(BlockchainValueOp.className, BlockchainValueOp);

export { BlockchainValueOp as BlockchainValueOp };