/**
 * users/getProfile.ts
 *
 * Lambda function — GET /users/profile (protected route)
 *
 * Responsibility: return the authenticated user's profile.
 *
 * This is the simplest protected Lambda in the project.
 * It demonstrates the core pattern of protected routes:
 * — userId comes from the Lambda Authorizer, not from the request
 * — the client never sends their own userId — the token proves who they are
 *
 * Flow:
 * 1. Extract userId from the authorizer context
 * 2. Fetch the user from DynamoDB by userId
 * 3. Return the user without passwordHash
 *
 * Express equivalent:
 *   router.get('/profile', authMiddleware, async (req, res) => { ... })
 */

import { APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import db from '../shared/dynamo';
import { ok, notFound, serverError } from '../shared/response';
import { AuthorizedEvent, User } from '../shared/types';

const USERS_TABLE = process.env.USERS_TABLE!;

// Note: we use AuthorizedEvent here — not APIGatewayProxyEvent
// because this route sits behind the Lambda Authorizer.
// AuthorizedEvent gives us type safety on event.requestContext.authorizer
export const handler = async (
  event: AuthorizedEvent
): Promise<APIGatewayProxyResult> => {
  try {

    // ── Extract userId from authorizer context ─────────────────────
    // The Lambda Authorizer already verified the JWT and extracted
    // userId from the token payload. It passes it here via context.
    //
    // Express equivalent:
    //   const userId = req.user.userId
    //
    // The client never sends userId directly — we always get it
    // from the verified token. This prevents users from accessing
    // other users' profiles by changing a parameter.
    const { userId } = event.requestContext.authorizer;

    // ── Fetch user from DynamoDB ───────────────────────────────────
    // GetCommand fetches a single item by its exact key.
    // This is the fastest DynamoDB operation — a direct key lookup.
    // Equivalent to Mongoose's User.findById(userId)
    //
    // Key requires both:
    //   userId — partition key (always required)
    // For the Users table there is no sort key, so userId alone is enough.
    const result = await db.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId }
    }));

    // GetCommand returns Item: undefined if the key does not exist
    // This should rarely happen in practice since the userId comes
    // from a valid JWT — but we handle it defensively
    if (!result.Item) {
      return notFound('User not found');
    }

    // ── Strip passwordHash before responding ───────────────────────
    const { passwordHash: _, ...safeUser } = result.Item as User;

    return ok({ user: safeUser });

  } catch (err) {
    console.error('getProfile error:', err);
    return serverError('Could not fetch profile');
  }
};