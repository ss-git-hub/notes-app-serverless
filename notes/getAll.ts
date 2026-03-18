/**
 * notes/getAll.ts
 *
 * Lambda function — GET /notes (protected route)
 *
 * Responsibility: return a paginated list of notes for the authenticated user.
 *
 * This Lambda demonstrates one of the most important DynamoDB concepts —
 * querying by partition key. The entire table design we chose in
 * resources.yml was driven by this exact query pattern.
 *
 * Why userId as partition key?
 * DynamoDB stores all items with the same partition key physically together.
 * This means fetching all notes for a user is a single fast read —
 * no matter how many total notes exist in the table from all users.
 *
 * Pagination — why it matters:
 *   Without pagination, a user with 10,000 notes would cause this Lambda to:
 *     — Read all 10,000 items from DynamoDB (expensive, slow)
 *     — Load all 10,000 items into Lambda memory (256MB default limit)
 *     — Return a massive JSON response (API Gateway 10MB limit)
 *   Pagination solves all three by reading and returning only a small slice.
 *
 * How DynamoDB pagination works (cursor-based):
 *   DynamoDB does NOT support SQL-style OFFSET pagination (skip N rows).
 *   Instead it uses a cursor — a pointer to the last item read.
 *
 *   First request: no cursor → DynamoDB returns the first `limit` items
 *                              + a LastEvaluatedKey if there are more.
 *   Next request:  send LastEvaluatedKey as ExclusiveStartKey → DynamoDB
 *                  continues from where it left off.
 *
 *   Why cursor pagination is better than offset:
 *     OFFSET reads and discards rows up to the offset — wasteful.
 *     Cursor jumps directly to the right position — efficient at any scale.
 *
 *   We base64-encode LastEvaluatedKey before sending it to the client because:
 *     — LastEvaluatedKey is a JSON object like { userId: "x", noteId: "y" }
 *     — Base64 makes it a clean opaque string that the client just echoes back
 *     — The client does not need to know or care about its internal structure
 *
 * Query parameters:
 *   limit   — max items per page (default 20, max 100)
 *   lastKey — base64-encoded cursor from the previous response (optional)
 *
 * Flow:
 * 1. Extract userId from authorizer context
 * 2. Read limit and lastKey from query string parameters
 * 3. Query DynamoDB with Limit and optional ExclusiveStartKey
 * 4. If there are more pages, base64-encode LastEvaluatedKey and return it
 * 5. Return notes + nextKey (null if last page)
 *
 * Express equivalent:
 *   router.get('/notes', authMiddleware, async (req, res) => { ... })
 */

import { APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import db from '../shared/dynamo';
import { ok, badRequest, serverError } from '../shared/response';
import { AuthorizedEvent, Note } from '../shared/types';

const NOTES_TABLE = process.env.NOTES_TABLE!;

// Maximum items the client can request per page.
// Prevents abuse (e.g. limit=999999) while still being flexible.
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export const handler = async (
  event: AuthorizedEvent
): Promise<APIGatewayProxyResult> => {
  try {

    const { userId } = event.requestContext.authorizer;

    // ── Read query string parameters ───────────────────────────────
    // API Gateway puts query string params in event.queryStringParameters.
    // This object is null if no query params were sent — so we default to {}.
    //
    // Express equivalent: req.query.limit, req.query.lastKey
    const params = event.queryStringParameters ?? {};

    // ── Parse and clamp limit ──────────────────────────────────────
    // parseInt() converts the string "20" to the number 20.
    // We clamp between 1 and MAX_LIMIT to prevent invalid values.
    // isNaN handles the case where the client sends limit=abc.
    const rawLimit = parseInt(params.limit ?? String(DEFAULT_LIMIT), 10);
    if (isNaN(rawLimit) || rawLimit < 1) {
      return badRequest('limit must be a positive integer');
    }
    const limit = Math.min(rawLimit, MAX_LIMIT);

    // ── Decode cursor (ExclusiveStartKey) ──────────────────────────
    // The client sends the base64-encoded nextKey from the previous response.
    // We decode it back to the DynamoDB key object to resume pagination.
    //
    // Buffer.from(str, 'base64').toString() decodes a base64 string.
    // JSON.parse() converts the JSON string back to the key object.
    //
    // If lastKey is missing or cannot be decoded, we start from the beginning.
    let exclusiveStartKey: Record<string, string> | undefined;
    if (params.lastKey) {
      try {
        const decoded = Buffer.from(params.lastKey, 'base64').toString('utf-8');
        exclusiveStartKey = JSON.parse(decoded);
      } catch {
        // Malformed cursor — treat as start of list rather than erroring.
        // A bad cursor is more likely a client bug than an attack attempt.
        exclusiveStartKey = undefined;
      }
    }

    // ── Query DynamoDB by partition key ────────────────────────────
    // QueryCommand retrieves all items that share the same partition key.
    //
    // IMPORTANT — QueryCommand vs ScanCommand:
    //   QueryCommand  — reads only items matching the partition key
    //                   fast, cheap, scales infinitely — always use this
    //   ScanCommand   — reads every single item in the entire table
    //                   slow, expensive, gets worse as table grows
    //                   never use this for user-scoped data
    //
    // Limit: tells DynamoDB to return at most this many items.
    //   Note: Limit applies BEFORE filter expressions — if you added a
    //   FilterExpression the actual returned count could be lower than Limit.
    //   We have no filter here so Limit == returned count exactly.
    //
    // ExclusiveStartKey: the cursor from the previous page.
    //   If undefined (first page), DynamoDB starts from the beginning.
    //   If set, DynamoDB resumes from the item after that key.
    //
    // ScanIndexForward: false — return items in descending sort key order.
    const result = await db.send(new QueryCommand({
      TableName: NOTES_TABLE,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey
    }));

    // ── Encode the next cursor ─────────────────────────────────────
    // LastEvaluatedKey is present only if there are MORE items after this page.
    // It is undefined when we are on the last page.
    //
    // We base64-encode it so the client gets a clean opaque string.
    // JSON.stringify converts the key object to a string.
    // Buffer.from(...).toString('base64') encodes it as base64.
    //
    // The client passes this back as ?lastKey=<value> on the next request.
    const nextKey = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return ok({
      notes:   result.Items as Note[],
      count:   result.Count ?? 0,
      // nextKey is the cursor for the next page.
      // null means this is the last page — no more items to fetch.
      nextKey
    });

  } catch (err) {
    console.error('getAllNotes error:', err);
    return serverError('Could not fetch notes');
  }
};
