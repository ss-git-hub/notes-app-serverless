/**
 * users/logout.ts
 *
 * Lambda function — POST /users/logout (public route, no authorizer)
 *
 * Responsibility: invalidate a refresh token so the session cannot be extended.
 *
 * Why is logout an API call?
 *   In a purely JWT-based system, "logout" just means the client deletes the
 *   token from storage. The server cannot truly invalidate a JWT because it
 *   never stored it — the token is self-contained.
 *
 *   With our refresh token stored in DynamoDB, we CAN do real server-side logout:
 *   deleting the refresh token row means the client can never get a new access
 *   token. Once the current access token expires (max 15 minutes), the session
 *   is truly dead. The client should also clear both tokens from its own storage.
 *
 * Why no Lambda Authorizer?
 *   Same reason as refresh — the client may be calling logout because the
 *   access token just expired. We only need the refresh token to identify
 *   which session to end.
 *
 * Idempotency:
 *   If the token does not exist (already deleted or never existed), we still
 *   return 200. From the client's perspective the session is gone either way —
 *   there is no reason to return an error for a token that is already invalid.
 *   This also prevents information leakage (not telling callers which tokens exist).
 *
 * Flow:
 * 1. Parse and validate request body with Zod
 * 2. Delete the refresh token from DynamoDB
 * 3. Return success (regardless of whether the token existed)
 *
 * Express equivalent:
 *   router.post('/logout', async (req, res) => { ... })
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import db from '../shared/dynamo';
import { ok, serverError } from '../shared/response';
import { parseBody, refreshTokenSchema } from '../shared/validate';

const REFRESH_TOKENS_TABLE = process.env.REFRESH_TOKENS_TABLE!;

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {

    // ── Parse and validate request body ───────────────────────────
    // We reuse refreshTokenSchema — logout takes the same { refreshToken }
    // body shape as the refresh endpoint.
    const parsed = parseBody(event.body, refreshTokenSchema);
    if (!parsed.success) return parsed.error;
    const { refreshToken } = parsed.data;

    // ── Delete the refresh token from DynamoDB ─────────────────────
    // DeleteCommand removes the item by its partition key (the token UUID).
    //
    // We do NOT use ConditionExpression here — if the token doesn't exist
    // (already deleted, or was never issued), DeleteCommand silently succeeds.
    // We want this — logout should always succeed from the client's perspective.
    // A missing token means the session is already gone, which is the goal.
    await db.send(new DeleteCommand({
      TableName: REFRESH_TOKENS_TABLE,
      Key: { token: refreshToken }
    }));

    // Session is now fully terminated.
    // The client should also clear both accessToken and refreshToken
    // from its own storage (localStorage, memory, etc.).
    return ok({ message: 'Logged out successfully' });

  } catch (err) {
    console.error('logout error:', err);
    return serverError('Could not log out');
  }
};
