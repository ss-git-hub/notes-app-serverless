/**
 * users/login.ts
 *
 * Lambda function — POST /users/login (public route, no authorizer)
 *
 * Responsibility: verify credentials and return an access token + refresh token.
 *
 * Access token vs Refresh token — why two tokens?
 *   A single long-lived token (our old '7d' JWT) is simple but has a problem:
 *   if it is stolen, the attacker has access for up to 7 days and you cannot
 *   revoke it because JWTs are stateless — the server does not track them.
 *
 *   The two-token pattern solves this:
 *     Access token  — short-lived JWT (15 minutes). Sent with every API request.
 *                     If stolen, it expires quickly. Cannot be revoked, but the
 *                     short window limits the damage.
 *     Refresh token — long-lived UUID (7 days). Stored in DynamoDB. Used ONLY
 *                     to get a new access token when the old one expires.
 *                     CAN be revoked by deleting it from DynamoDB (logout).
 *                     If stolen, the user or admin can invalidate it instantly.
 *
 *   The client flow:
 *     1. Login  → receive accessToken (15m) + refreshToken (7d)
 *     2. Every API call → send accessToken in Authorization header
 *     3. API returns 401 → accessToken expired
 *     4. Call POST /users/refresh with refreshToken → get new accessToken
 *     5. Retry the original request with the new accessToken
 *     6. Logout → call POST /users/logout with refreshToken → server deletes it
 *
 * Flow:
 * 1. Parse and validate request body with Zod
 * 2. Find user by email via GSI
 * 3. Compare submitted password against stored bcrypt hash
 * 4. Sign a short-lived access token (JWT, 15 minutes)
 * 5. Generate a refresh token (UUID), store it in DynamoDB with 7-day TTL
 * 6. Return both tokens + safe user data
 *
 * Express equivalent:
 *   router.post('/login', async (req, res) => { ... })
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from '../shared/dynamo';
import { ok, unauthorized, serverError } from '../shared/response';
import { parseBody, loginSchema } from '../shared/validate';
import { User, RefreshToken } from '../shared/types';

const USERS_TABLE          = process.env.USERS_TABLE!;
const REFRESH_TOKENS_TABLE = process.env.REFRESH_TOKENS_TABLE!;

// JWT_SECRET is pulled from SSM Parameter Store at deploy time
// and injected as an environment variable via config/environment.yml
const JWT_SECRET = process.env.JWT_SECRET!;

// Refresh token lifetime: 7 days expressed in seconds for the DynamoDB TTL.
// Unix TTL = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {

    // ── Parse and validate request body ───────────────────────────
    // parseBody() safely handles malformed JSON (returns 400) and runs
    // Zod validation (checks email format, password presence) in one step.
    const parsed = parseBody(event.body, loginSchema);
    if (!parsed.success) return parsed.error;
    const { email, password } = parsed.data;

    // ── Find user by email via GSI ─────────────────────────────────
    // We cannot use GetCommand here because GetCommand requires
    // the partition key (userId) — which we don't know yet at login time.
    // Instead we query the email GSI to look up the user by email.
    // This is why we created the GSI in resources.yml.
    const result = await db.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: {
        ':email': email.toLowerCase()
      }
    }));

    // ── Intentionally vague error message ─────────────────────────
    // Never reveal whether the email exists or not.
    // If we said "email not found" an attacker could enumerate
    // which emails are registered in your system.
    // Always return the same message for both wrong email and wrong password.
    if (!result.Items || result.Items.length === 0) {
      return unauthorized('Invalid email or password');
    }

    // QueryCommand always returns an array — we take the first item
    // and cast it to our User type so TypeScript knows its shape
    const user = result.Items[0] as User;

    // ── Verify password ────────────────────────────────────────────
    // bcrypt.compare() takes the plain text password the user submitted
    // and the hash stored in DynamoDB and securely compares them.
    // It returns true if they match, false if not.
    // Never compare passwords with === — always use bcrypt.compare()
    const passwordValid = await bcrypt.compare(password, user.passwordHash);

    if (!passwordValid) {
      // Same vague error as above — intentional
      return unauthorized('Invalid email or password');
    }

    // ── Sign access token (JWT, short-lived) ──────────────────────
    // The access token is a signed JWT — self-contained and stateless.
    // The Lambda Authorizer verifies it on every protected request.
    //
    // expiresIn: '15m' — expires in 15 minutes.
    // Short expiry limits damage if the token is intercepted.
    // When it expires the client uses the refresh token to get a new one.
    const accessToken = jwt.sign(
      { userId: user.userId, email: user.email },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    // ── Generate refresh token (UUID, long-lived) ──────────────────
    // The refresh token is NOT a JWT — it is a random UUID that we
    // store in DynamoDB. This means:
    //   — We can instantly revoke it by deleting the DB row (logout)
    //   — The client cannot decode it (no payload to tamper with)
    //   — uuidv4() is cryptographically random — not guessable
    const refreshToken = uuidv4();

    // ── Store refresh token in DynamoDB ───────────────────────────
    // ttl is a Unix timestamp in seconds — when this time passes,
    // DynamoDB will automatically delete the item (TTL feature).
    // Math.floor(Date.now() / 1000) converts JS milliseconds to seconds.
    const ttl = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS;

    const refreshTokenItem: RefreshToken = {
      token:     refreshToken,
      userId:    user.userId,
      email:     user.email,
      ttl,
      createdAt: new Date().toISOString()
    };

    await db.send(new PutCommand({
      TableName: REFRESH_TOKENS_TABLE,
      Item: refreshTokenItem
    }));

    // ── Strip passwordHash before responding ───────────────────────
    const { passwordHash: _, ...safeUser } = user;

    return ok({
      message:      'Login successful',
      accessToken,  // short-lived (15m) — send in Authorization header
      refreshToken, // long-lived (7d)  — store securely, use to refresh
      user: safeUser
    });

  } catch (err) {
    console.error('login error:', err);
    return serverError('Could not log in');
  }
};