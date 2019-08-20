import { DelegateRequest } from "../db";
import { instanceConfig, ethereumGlobalConfig } from "../../config";
import { provider, errorCode, getWallet, getContract } from "./ethers";

// Must always run single-threaded
export async function syncAndPublish () {

  const dr = await DelegateRequest.collection();
  const delegateWallet = await getWallet();
  console.log(`Sync and publish start; delegateWallet=${ delegateWallet.address }`);

  // Step 1. Find the last mined transaction in the local DB and determine the next nonce
  // Delegated Req [mined    ] -> [mining   ] -> [mining   ] -> [mining   ] -> [confirmed] -> [confirmed]
  // Props         [nonce=?  ] -> [nonce=?  ] -> [nonce=?  ] -> [nonce=?  ] -> [nonce=?  ] -> [nonce=?  ]
  // Step          ^^^^^^^^^^^

  const lastMinedTx = (await dr
    .find({
      status: DelegateRequest.status.mined
    })
    .sort({ $natural: -1 })
    .limit(1)
    .toArray())[0];

  let nextNonce;

  if (!lastMinedTx) { // No mined transactions: init; get the last nonce from the network
    nextNonce = await provider.getTransactionCount(delegateWallet.address);
  } else { // Mined transactions: pick the next nonce
    nextNonce = lastMinedTx[0].nonce + 1;
  }
  console.log(`Next nonce is ${ nextNonce }`);

  // Step 2. Query all con-new or failed transactions that go after the mined transactions.
  //         Also pick mined transactions that may have appeared in a little while (concurrent).
  // Delegated Req [mined    ] -> [MINED    ] -> [mining   ] -> [mining   ] -> [confirmed] -> [confirmed]
  // Props         [NONCE=3  ] -> [nonce=?  ] -> [nonce=?  ] -> [nonce=?  ] -> [nonce=?  ] -> [nonce=?  ]
  // Step                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

  const requestQueue = await dr
    .find({
      ...(!lastMinedTx ? {} : { // Everything after last mined tx
        _id: {
          $gt: lastMinedTx._id
        }
      }),
      status: { // Which is not "new" or "mined" (used $in because more statuses may be added at some point)
        $in: [
          DelegateRequest.status.confirmed,
          DelegateRequest.status.mining,
          DelegateRequest.status.mined
        ]
      }
    })
    .sort({ $natural: 1 })
    .toArray();

  // Step 3. Start traversing all found delegated transaction requests
  console.log(`Number of requests: ${ requestQueue.length }`);

  for (let i = 0; i < requestQueue.length; ++i) {

    const request = requestQueue[i];
    console.log(`Processing request #${ i } status ${ request.status }`);

    // Step 3.1. As for mined transactions, just get the nonce and keep going
    // Delegated Req [mined    ] -> [mined    ] -> [mining   ] -> [mining   ] -> [confirmed] -> [confirmed]
    // Props         [nonce=3  ] -> [NONCE=4  ] -> [nonce=?  ] -> [nonce=?  ] -> [nonce=?  ] -> [nonce=?  ]
    // Step                         ^^^^^^^^^^^
    if (request.status === DelegateRequest.status.mined) {
      console.log(`Request status is mined, skipping`);

      nextNonce = request.nonce + 1;
      continue;

    // Step 3.2. As for transaction that are currently in the mining state, get their status and see all options
    // Delegated Req [mined    ] -> [mined    ] -> [mining   ] -> [mining   ] -> [confirmed] -> [confirmed]
    // Props         [nonce=3  ] -> [nonce=4  ] -> [nonce=?  ] -> [nonce=?  ] -> [nonce=?  ] -> [nonce=?  ]
    // Step                                        ^^^^^^^^^^^
    } else if (request.status === DelegateRequest.status.mining) {
      console.log(`Request status is mining`);

      const txReceipt = await provider.getTransactionReceipt(request.transactionHash);

      if (txReceipt) { // Receipt found

        if (txReceipt.confirmations < ethereumGlobalConfig.requiredConfirmations) { // Exit if not enough confirmations
          nextNonce = request.nonce ? (request.nonce + 1) : (nextNonce + 1);
          continue;
        }
        // De-bignumberify (for proper JSON encoding)
        txReceipt.gasUsed = +txReceipt.gasUsed;
        txReceipt.cumulativeGasUsed = +txReceipt.cumulativeGasUsed;
        // If enough confirmations, mark TX as mined
        const { nonce } = await provider.getTransaction(request.transactionHash);
        
        await dr.findOneAndUpdate({
          _id: request._id
        }, {
          $set: {
            status: DelegateRequest.status.mined,
            txReceipt: txReceipt,
            nonce
          }
        });

        nextNonce = nonce + 1;
        continue;

      } else { // No TX receipt so far: wait for it; republish TX
        // Temporarily: do nothing (just wait)
        ++nextNonce;
        continue;
      }

    // Step 3.3. Publish confirmed transactions
    // Delegated Req [mined    ] -> [mined    ] -> [mining   ] -> [mining   ] -> [confirmed] -> [confirmed]
    // Props         [nonce=3  ] -> [nonce=4  ] -> [nonce=5  ] -> [nonce=6  ] -> [nonce=7  ] -> [nonce=?  ]
    // Step                                                                      ^^^^^^^^^^^
    } else if (request.status === DelegateRequest.status.confirmed) {
      console.log(`Request status is confirmed, publishing`);

      try { // Try to publish transaction

        const { transactionHash, nonce } = await publishTransaction(request, nextNonce);
        console.log(`TX hash=${ transactionHash }, nonce=${ nonce }`);

        await dr.findOneAndUpdate({ // Update status, transactionHash, nonce (can be higher due to unknown TXs)
          _id: request._id
        }, {
          $set: {
            status: DelegateRequest.status.mining,
            transactionHash: transactionHash,
            nonce: nonce
          }
        });

        nextNonce = nonce + 1;
        continue;

      } catch (e) { // On any error

        await dr.findOneAndUpdate({ // Mark transaction as failed
          _id: request._id
        }, {
          $set: {
            status: DelegateRequest.status.failed,
            reason: e.code === errorCode.INSUFFICIENT_FUNDS
              ? "Delegate account has no Ether on its balance"
              : "Transaction error when publishing: " + e.toString()
          }
        });

        continue;

      }

    } else {
      console.warn(`Unknown request status ${ request.status } skipped (?)`);
      continue;
    }

  }

}

async function publishTransaction (confirmedRequest, nonce) {

  const contract = await getContract(confirmedRequest.context.contract.address);
  let transactionHash;

  while (true) {
    try {
      console.log(`Publish attempt`);
      transactionHash = await contract.functions[confirmedRequest.delegatedFunctionName](...confirmedRequest.delegatedFunctionArguments.concat({
        nonce
      }));
      break;
    } catch (e) {
      if (e.code === errorCode.NONCE_EXPIRED || e.code === errorCode.REPLACEMENT_UNDERPRICED) {
        ++nonce;
        continue;
      }
      throw e;
    }
  }

  return {
    transactionHash,
    nonce
  };

}