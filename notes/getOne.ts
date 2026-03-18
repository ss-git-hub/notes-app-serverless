/**
 * notes/getOne.ts
 *
 * Lambda function — GET /notes/{id} (protected route)
 *
 * Responsibility: return a single note by its noteId.
 *
 * This Lambda demonstrates the difference between QueryCommand
 * and GetCommand in DynamoDB:
 *
 *   GetCommand   — fetches exactly one item by its full composite key
 *                  (partition key + sort key). Fastest possible read.
 *                  Use when you know both keys.
 *
 *   QueryCommand — fetches multiple items by partition key.
 *                  Use when you want all items for a user.
 *
 * Here we know both userId (from token) and noteId (from URL),
 * so GetCommand is the right choice.
 *
 * Ownership is automatically enforced by the composite key —
 * DynamoDB will only find the item if BOTH userId AND noteId match.
 * A user cannot fetch another user's note even if they know the noteId,
 * because their userId will not match.
 *
 * Flow:
 * 1. Extract userId from authorizer context
 * 2. Extract noteId from URL path parameters
 * 3. Fetch the note by composite key
 * 4. Return 404 if not found, note if found
 *
 * Express equivalent:
 *   router.get('/notes/:id', authMiddleware, async (req, res) => { ... })
 */

import { APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import db from '../shared/dynamo';
import { ok, badRequest, notFound, serverError } from '../shared/response';
import { AuthorizedEvent, Note } from '../shared/types';

const NOTES_TABLE = process.env.NOTES_TABLE!;

export const handler = async (
  event: AuthorizedEvent
): Promise<APIGatewayProxyResult> => {
  try {

    const { userId } = event.requestContext.authorizer;

    // ── Extract noteId from path parameters ───────────────────────
    // Path parameters come from the URL — e.g. GET /notes/abc-123
    // In functions.yml we defined the path as /notes/{id}
    // which makes 'id' available here as event.pathParameters.id
    //
    // Express equivalent: req.params.id
    //
    // We use optional chaining (?.) because pathParameters can be
    // null if no path parameters were sent — TypeScript requires
    // us to handle this case
    const noteId = event.pathParameters?.id;

    if (!noteId) {
      return badRequest('Note ID is required');
    }

    // ── Fetch note by composite key ────────────────────────────────
    // GetCommand requires the full composite key:
    //   userId — partition key (from token — proves ownership)
    //   noteId — sort key     (from URL path parameter)
    //
    // If a user tries to fetch a note that belongs to someone else,
    // DynamoDB simply returns nothing — not found.
    // We never explicitly check ownership — the key structure handles it.
    const result = await db.send(new GetCommand({
      TableName: NOTES_TABLE,
      Key: { userId, noteId }
    }));

    // GetCommand returns Item: undefined when the key does not exist
    // This covers both "note does not exist" and "note belongs to
    // a different user" — both return the same 404 to the client.
    // We intentionally do not distinguish between the two cases —
    // telling a user "that note belongs to someone else" would be
    // an information leak.
    if (!result.Item) {
      return notFound('Note not found');
    }

    return ok({ note: result.Item as Note });

  } catch (err) {
    console.error('getNote error:', err);
    return serverError('Could not fetch note');
  }
};