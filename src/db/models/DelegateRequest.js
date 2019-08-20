import { getCollection } from "../db";
import { instanceConfig } from "../../../config";

let collectionPromise = getCollection("delegate-request");

(async function initIndexes () {
  const collection = await collectionPromise;
  await collection.createIndex({
    id: 1
  }, {
    unique: true
  });
  await collection.createIndex({
    status: 1,
    expiresAt: 1,
    signer: 1
  });
})();

export const status = {
  new: 0, // the delegated transaction request was just requested and is not confirmed yet
  confirmed: 1, // the transaction is confirmed and is ready to be published (picked up by worker shortly)
  mining: 2, // the transaction is in mining state
  mined: 3, // when the transaction is mined both successfully or with an error (but mined!)
  failed: 4 // any failed attempts to publish or republish a transaction, including transaction drop, etc
};

export async function create ({ id, context, signer, fee, signatureOptions }) {
  const collection = await collectionPromise;
  const now = new Date();
  const result = await collection.insertOne({
    id,
    status: status.new,
    signer,
    context,
    fee,
    signatureOptions,
    createdAt: now,
    expiresAt: context.expiresAt
      ? new Date(context.expiresAt * 1000)
      : new Date(now.getTime() + instanceConfig.defaultExpiresAtSeconds * 1000)
  });
  const doc = result.ops[0];
  delete doc._id;
  return doc;
}

export async function findOne (q) {
  const collection = await collectionPromise;
  const result = await collection.findOne(q);
  return result;
}

export async function findOneAndUpdate (q, u) {
  const collection = await collectionPromise;
  const result = await collection.findOneAndUpdate(q, u, {
    returnNewDocument: true
  });
  return result;
}

export async function find (q) {
  const collection = await collectionPromise;
  const result = await collection.find(q);
  return result;
}

export async function findCount (q) {
  const collection = await collectionPromise;
  const result = await collection.find(q).count;
  return result;
}

export async function collection () {
  return await collectionPromise;
}
