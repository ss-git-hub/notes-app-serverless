/**
 * users/refresh.ts
 *
 * Lambda function — POST /users/refresh (public route, no authorizer)
 *
 * Responsibility: issue a new short-lived access token using a valid refresh token.
 *
 * Why is this needed?
 *   The access token expires after 15 minutes. Rather than forcing the user
 *   to log in again, the client silently calls this endpoint with the
 *   refresh token to get a fresh access token — no password required.
 *   The user never notices the token was refreshed.
 *
 * Why no Lambda Authorizer on this route?
 *   The refresh token IS the credential here — the client is proving identity
 *   by presenting the refresh token, not a (now-expired) access token.
 *   Using the authorizer would require a valid access token, which defeats
 *   the purpose of this endpoint (the access token is expired — that's why
 *   we're here).
 *
 * Security checks performed:
 *   1. The refresh token must exist in DynamoDB (not forged or already deleted)
 *   2. The ttl must not be in the past (DynamoDB TTL may not have deleted
 *      it yet — items can linger up to 48h after expiry, so we check manually)
 *
 * Flow:
 * 1. Parse and validate request body with Zod
 * 2. Look up the refresh token in DynamoDB
 * 3. Reject if not found (invalid or already logged out)
 * 4. Reject if ttl is in the past (expired)
 * 5. Sign and return a new short-lived access token
 *
 * Express equivalent:
 *   router.post('/refresh', async (req, res) => { ... })
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import jwt from 'jsonwebtoken';
import db from '../shared/dynamo';
import { ok, unauthorized, serverError } from '../shared/response';
import { parseBody, refreshTokenSchema } from '../shared/validate';
import { RefreshToken } from '../shared/types';

const REFRESH_TOKENS_TABLE = process.env.REFRESH_TOKENS_TABLE!;
const JWT_SECRET           = process.env.JWT_SECRET!;

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {

    // ── Parse and validate request body ───────────────────────────
    // refreshTokenSchema just checks that refreshToken is a non-empty string.
    // DynamoDB lookup below confirms whether it is actually valid.
    const parsed = parseBody(event.body, refreshTokenSchema);
    if (!parsed.success) return parsed.error;
    const { refreshToken } = parsed.data;

    // ── Look up refresh token in DynamoDB ─────────────────────────
    // GetCommand does a direct O(1) lookup by partition key (token UUID).
    // This is fast regardless of how many tokens exist in the table.
    //
    // If the token is not found it means one of:
    //   — It was never issued (the client sent a forged token)
    //   — It was deleted by logout
    //   — DynamoDB's TTL already cleaned it up
    // We return the same 401 in all cases — no information leak.
    const result = await db.send(new GetCommand({
      TableName: REFRESH_TOKENS_TABLE,
      Key: { token: refreshToken }
    }));

    if (!result.Item) {
      return unauthorized('Invalid or expired refresh token');
    }

    const storedToken = result.Item as RefreshToken;

    // ── Check token has not expired ────────────────────────────────
    // DynamoDB TTL deletes expired items eventually (within 48 hours)
    // but not immediately. We check the ttl value manually so we never
    // issue a new access token for an expired refresh token, even if
    // DynamoDB hasn't cleaned it up yet.
    //
    // Math.floor(Date.now() / 1000) converts JS milliseconds to seconds
    // to match the Unix timestamp format stored in the ttl field.
    const nowInSeconds = Math.floor(Date.now() / 1000);
    if (storedToken.ttl < nowInSeconds) {
      return unauthorized('Refresh token has expired — please log in again');
    }

    // ── Issue new access token ─────────────────────────────────────
    // We use the userId and email stored in the refresh token row —
    // no need to look up the user in the UsersTable for a second query.
    // Same payload and expiry as the token issued at login.
    const accessToken = jwt.sign(
      { userId: storedToken.userId, email: storedToken.email },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    return ok({
      message: 'Token refreshed',
      accessToken // client replaces its old expired access token with this
    });

  } catch (err) {
    console.error('refresh error:', err);
    return serverError('Could not refresh token');
  }
};
