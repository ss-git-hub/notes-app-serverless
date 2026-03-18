/**
 * tests/helpers.ts
 *
 * Shared test utilities — factory functions for building fake Lambda events.
 *
 * Why factory functions instead of copy-pasting event objects?
 *   Each test needs a slightly different event (different body, different user).
 *   Factory functions provide a sensible default and let each test override
 *   only the parts it cares about using the spread operator { ...defaults, ...overrides }.
 *
 *   This is the "builder pattern" — common in testing to reduce boilerplate.
 *
 * APIGatewayProxyEvent shape:
 *   Lambda receives events from API Gateway in a specific shape.
 *   body is always a JSON string (not an object) — just like HTTP sends raw text.
 *   pathParameters holds URL params like { id: 'abc' } from /notes/{id}.
 *   queryStringParameters holds query params like { limit: '20' } from ?limit=20.
 *   requestContext.authorizer holds userId/email injected by the Lambda Authorizer.
 *
 * Express equivalent:
 *   These factories create objects that resemble Express's req —
 *   makePublicEvent() ≈ a req without req.user
 *   makeAuthorizedEvent() ≈ a req with req.user set by auth middleware
 */

import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { AuthorizedEvent } from '../shared/types';

// ── Shared base ───────────────────────────────────────────────────────────────

/**
 * The minimum valid shape of an APIGatewayProxyEvent.
 * Most fields are not needed for unit tests — we only include what the
 * Lambda handlers actually read. TypeScript requires all fields, so we
 * cast to the full type at the end.
 */
const BASE_EVENT = {
  httpMethod: 'POST',
  path: '/',
  headers: { 'Content-Type': 'application/json' },
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  pathParameters: null,
  stageVariables: null,
  body: null,
  isBase64Encoded: false,
  resource: '/',
  requestContext: {
    accountId: '123456789',
    apiId: 'test-api',
    httpMethod: 'POST',
    identity: {} as never,
    path: '/',
    protocol: 'HTTP/1.1',
    requestId: 'test-request-id',
    requestTimeEpoch: Date.now(),
    resourceId: 'test-resource',
    resourcePath: '/',
    stage: 'test',
    authorizer: {}
  }
};

// ── Factory functions ─────────────────────────────────────────────────────────

/**
 * makePublicEvent — creates a fake event for public (unauthenticated) endpoints.
 * Used for: POST /users/register, POST /users/login, POST /users/refresh, etc.
 *
 * body: pass an object — it will be JSON.stringify'd to match how API Gateway
 *       delivers it to Lambda (always a string, never a parsed object).
 */
export function makePublicEvent(overrides: {
  body?: Record<string, unknown> | null;
  queryStringParameters?: Record<string, string> | null;
  pathParameters?: Record<string, string> | null;
  httpMethod?: string;
} = {}): APIGatewayProxyEvent {
  return {
    ...BASE_EVENT,
    ...overrides,
    // Convert body object to JSON string — API Gateway always sends strings
    body: overrides.body !== undefined
      ? (overrides.body === null ? null : JSON.stringify(overrides.body))
      : null,
    requestContext: BASE_EVENT.requestContext
  } as unknown as APIGatewayProxyEvent;
}

/**
 * makeAuthorizedEvent — creates a fake event for protected endpoints.
 * The Lambda Authorizer injects userId and email into requestContext.authorizer.
 * This factory simulates that by pre-populating authorizer with test values.
 *
 * Used for: all notes endpoints, GET/PUT /users/profile.
 */
export function makeAuthorizedEvent(overrides: {
  body?: Record<string, unknown> | null;
  queryStringParameters?: Record<string, string> | null;
  pathParameters?: Record<string, string> | null;
  httpMethod?: string;
  userId?: string;
  email?: string;
} = {}): AuthorizedEvent {
  const { userId = 'test-user-id', email = 'test@example.com', ...rest } = overrides;
  return {
    ...BASE_EVENT,
    ...rest,
    body: rest.body !== undefined
      ? (rest.body === null ? null : JSON.stringify(rest.body))
      : null,
    requestContext: {
      ...BASE_EVENT.requestContext,
      // Simulate what the Lambda Authorizer injects after verifying the JWT
      authorizer: { userId, email }
    }
  } as unknown as AuthorizedEvent;
}

// ── Common test fixtures ──────────────────────────────────────────────────────

/** A complete User item as stored in DynamoDB — includes passwordHash */
export const TEST_USER = {
  userId:       'test-user-id',
  email:        'test@example.com',
  name:         'Test User',
  passwordHash: '$2a$12$hashedpassword',  // bcrypt hash placeholder
  createdAt:    '2026-01-01T00:00:00.000Z',
  updatedAt:    '2026-01-01T00:00:00.000Z'
};

/** A complete Note item as stored in DynamoDB */
export const TEST_NOTE = {
  userId:    'test-user-id',
  noteId:    'test-note-id',
  title:     'Test Note',
  content:   'Test content',
  tags:      ['test'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};
