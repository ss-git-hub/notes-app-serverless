/**
 * shared/dynamo.ts
 *
 * Creates and exports a single shared DynamoDB client used by all Lambda functions.
 *
 * Why a shared client?
 * In Express you create one mongoose connection and reuse it everywhere.
 * Same principle here — create the client once, export it, import it wherever needed.
 *
 * Why DynamoDBDocumentClient and not DynamoDBClient directly?
 * DynamoDBClient is the low-level client. It requires you to write items in
 * DynamoDB's verbose format:
 *   { userId: { S: "abc" }, title: { S: "My Note" } }
 *
 * DynamoDBDocumentClient is a wrapper that automatically converts between
 * plain JavaScript objects and DynamoDB's format, so you can write:
 *   { userId: "abc", title: "My Note" }
 *
 * Always use DynamoDBDocumentClient — it's the Mongoose of DynamoDB.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * The base DynamoDB client.
 * AWS_REGION is automatically set by the Lambda execution environment.
 * The fallback 'us-east-1' is a safety net for local development.
 */
const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'us-east-1'
});

/**
 * The document client wraps the base client and handles
 * marshalling (JS → DynamoDB format) and unmarshalling (DynamoDB → JS) automatically.
 *
 * marshallOptions:
 *   removeUndefinedValues: true
 *     — DynamoDB does not accept undefined values. If your object has an
 *       undefined field, this removes it automatically instead of throwing an error.
 *
 *   convertEmptyValues: false
 *     — Do not convert empty strings "" to null.
 *       We want to store empty strings as-is if they appear.
 */
const db = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false
  }
});

export default db;