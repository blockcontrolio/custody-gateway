import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { custodyAbi } from '@erc7824/nitrolite/dist/abis/generated.js';
import { getPackedState } from '@erc7824/nitrolite/dist/utils/state.js';
const ETH_RPC = process.env.ETHEREUM_RPC_URL;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY, 'hex');
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const CUSTODY = '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f';
const BROKER = '0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a';
const CHANNEL_ID = '0xd25ad7719c748181fca7d072c4b70f29768cb4cff06c8dd3145f222f72a23bc1';
const SERVER_SIG = '0xad694614581fa3a4daea2c7cfbb6565150f229d89897cd4c693428f1da8dbbed596254ddfb6ba433162eb6afcc9d044a523b3ba8964aa4571aab3d9d82b2b6571b';
const RESIZE_STATE_DATA = '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000000';
function decrypt(enc, iv, tag) {
    const d = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
}
async function main() {
    const prisma = new PrismaClient();
    const aliceRow = await prisma.managedKey.findUnique({ where: { address: ALICE2 } });
    await prisma.$disconnect();
    const aliceKey = decrypt(aliceRow.encryptedKey, aliceRow.iv, aliceRow.tag);
    const aliceAccount = privateKeyToAccount(aliceKey);
    const publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });
    const aliceWC = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });
    const chainData = await publicClient.readContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'getChannelData',
        args: [CHANNEL_ID],
    });
    const [channel, status, wallets, challengeExpiry, lastState] = chainData;
    console.log('On-chain: version=', lastState.version.toString(), 'intent=', lastState.intent.toString());
    const initProof = {
        intent: Number(lastState.intent),
        version: lastState.version,
        data: lastState.data,
        allocations: lastState.allocations.map((a) => ({
            destination: a.destination,
            token: a.token,
            amount: a.amount,
        })),
        sigs: [...lastState.sigs],
    };
    const resizeAllocations = [
        { destination: ALICE2, token: USDC, amount: 1000000n },
        { destination: BROKER, token: USDC, amount: 0n },
    ];
    const unsignedResize = { intent: 2, version: 1n, data: RESIZE_STATE_DATA, allocations: resizeAllocations };
    const packedResize = getPackedState(CHANNEL_ID, unsignedResize);
    const aliceStateSig = await aliceAccount.signMessage({ message: { raw: packedResize } });
    const candidate = { ...unsignedResize, sigs: [aliceStateSig, SERVER_SIG] };
    console.log('\nSimulating resize...');
    const { request } = await publicClient.simulateContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'resize',
        args: [CHANNEL_ID, candidate, [initProof]],
        account: aliceAccount,
    });
    console.log('Simulation passed! Sending tx...');
    const txHash = await aliceWC.writeContract(request);
    console.log(`TX: ${txHash}`);
    console.log('Waiting for confirmation...');
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`Confirmed in block ${receipt.blockNumber}, status: ${receipt.status}`);
    const newData = await publicClient.readContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'getChannelData',
        args: [CHANNEL_ID],
    });
    console.log('\nNew on-chain state:');
    console.log('  version:', newData[4].version.toString());
    console.log('  intent:', newData[4].intent.toString());
    for (const a of newData[4].allocations) {
        console.log(`  ${a.destination}: ${a.amount.toString()}`);
    }
    const chBal = await publicClient.readContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'getChannelBalances',
        args: [CHANNEL_ID, [USDC]],
    });
    console.log('\nChannel USDC balance:', chBal[0].toString());
    const acctBal = await publicClient.readContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'getAccountsBalances',
        args: [[ALICE2], [USDC]],
    });
    console.log('Alice Custody USDC:', acctBal[0][0].toString());
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
//# sourceMappingURL=execute-resize.js.map