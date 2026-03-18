/**
 * shared/types.ts
 *
 * Central place for all TypeScript interfaces used across the project.
 * Defining types here and importing them everywhere ensures consistency
 * and means if a shape changes, you only update it in one place.
 */

import { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Represents a user item as stored in DynamoDB.
 * This is the full shape including passwordHash.
 * Never return this directly to the client — use SafeUser instead.
 */
export interface User {
  userId: string;       // partition key in DynamoDB — unique per user (uuid)
  email: string;        // stored lowercase — queried via GSI during login
  name: string;
  passwordHash: string; // bcrypt hash — NEVER returned to the client
  createdAt: string;    // ISO 8601 string e.g. "2026-01-01T00:00:00.000Z"
  updatedAt: string;
}

/**
 * SafeUser is what we return to the client.
 * Omit<> is a TypeScript utility that creates a new type
 * by removing specified keys from an existing type.
 * This makes it impossible to accidentally expose passwordHash in a response.
 */
export type SafeUser = Omit<User, 'passwordHash'>;

/**
 * Represents a note item as stored in DynamoDB.
 * userId + noteId together form the composite key:
 *   - userId is the partition key (groups all notes for a user)
 *   - noteId is the sort key (uniquely identifies a note within that user)
 */
export interface Note {
  userId: string;    // partition key — ties note to its owner
  noteId: string;    // sort key — unique per note (uuid)
  title: string;
  content: string;
  tags: string[];    // array of tag strings e.g. ["aws", "learning"]
  createdAt: string;
  updatedAt: string;
}

/**
 * RefreshToken — an item stored in the RefreshTokensTable.
 *
 * Why store refresh tokens in DynamoDB instead of making them JWTs?
 *   A JWT is self-contained — once issued it is valid until it expires
 *   and the server cannot invalidate it. If a refresh token were a JWT,
 *   logging out would do nothing because the token would still be valid.
 *
 *   By storing a random UUID in DynamoDB we can invalidate any session
 *   instantly by deleting that row — logout actually works, and if a
 *   token is stolen we can revoke it immediately.
 *
 * TTL (Time To Live):
 *   DynamoDB has a native TTL feature. If you set a numeric Unix timestamp
 *   attribute (seconds since epoch) on an item and tell DynamoDB which
 *   attribute is the TTL, DynamoDB will automatically delete expired items
 *   in the background — no cron job or cleanup Lambda needed.
 *   We set ttl = now + 7 days at login time.
 */
export interface RefreshToken {
  token:     string;  // partition key — the UUID we issued to the client
  userId:    string;  // who this token belongs to
  email:     string;  // carried through so refresh doesn't need a Users lookup
  ttl:       number;  // Unix timestamp (seconds) — DynamoDB deletes after this
  createdAt: string;  // ISO string — human-readable for debugging
}

/**
 * Shape of the JWT payload — what gets encoded inside the token.
 * When a user logs in, we sign { userId, email } into the JWT.
 * The Lambda Authorizer decodes this and passes it to protected Lambdas.
 *
 * iat = issued at (timestamp) — added automatically by jsonwebtoken
 * exp = expiry (timestamp)    — added automatically by jsonwebtoken
 * Both are optional here because we don't set them manually.
 */
export interface JwtPayload {
  userId: string;
  email: string;
  iat?: number;
  exp?: number;
}

/**
 * Extended API Gateway event type for protected (authorizer-guarded) routes.
 *
 * By default APIGatewayProxyEvent.requestContext.authorizer is typed as
 * Record<string, unknown> which means TypeScript doesn't know what's inside it.
 *
 * We extend it here to tell TypeScript exactly what the Lambda Authorizer
 * passes through — userId and email. This gives us type safety in every
 * protected Lambda handler.
 *
 * Usage: use AuthorizedEvent instead of APIGatewayProxyEvent in any Lambda
 * that sits behind the authorizer.
 */
export interface AuthorizedEvent extends APIGatewayProxyEvent {
  requestContext: APIGatewayProxyEvent['requestContext'] & {
    authorizer: {
      userId: string;
      email: string;
    };
  };
}