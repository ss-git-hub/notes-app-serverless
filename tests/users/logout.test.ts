/**
 * tests/users/logout.test.ts
 *
 * Unit tests for the POST /users/logout Lambda handler.
 *
 * Testing strategy:
 *   DynamoDB DeleteCommand is mocked.
 *   Logout is idempotent — succeeds whether or not the token exists.
 *
 * What we test:
 *   — Happy path: valid token sent → 200, DeleteCommand called
 *   — Idempotency: non-existent token → 200 (no error)
 *   — Validation failure: missing refreshToken → 400
 *   — DynamoDB failure → 500
 */

import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { makePublicEvent } from '../helpers';

// ── Env ───────────────────────────────────────────────────────────────────────

process.env.REFRESH_TOKENS_TABLE = 'test-refresh-tokens-table';

import { handler } from '../../users/logout';

// ── DynamoDB mock ─────────────────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('logout handler', () => {

  it('returns 200 and deletes the refresh token', async () => {
    // DeleteCommand succeeds (token existed)
    ddbMock.on(DeleteCommand).resolves({});

    const event = makePublicEvent({
      body: { refreshToken: 'some-valid-token' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).message).toMatch(/logged out/i);
  });

  it('calls DeleteCommand with the correct key', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    const event = makePublicEvent({
      body: { refreshToken: 'token-to-delete' }
    });

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
      TableName: 'test-refresh-tokens-table',
      Key: { token: 'token-to-delete' }
    });
  });

  it('returns 200 even when token does not exist (idempotent)', async () => {
    // DynamoDB DeleteCommand silently succeeds for non-existent keys —
    // the mock also resolves successfully to simulate this behaviour.
    ddbMock.on(DeleteCommand).resolves({});

    const event = makePublicEvent({
      body: { refreshToken: 'already-deleted-token' }
    });

    const result = await handler(event);

    // Must not return 404 — logout should always succeed from the client's view
    expect(result.statusCode).toBe(200);
  });

  it('returns 400 when refreshToken field is missing', async () => {
    const event = makePublicEvent({
      body: {}
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for malformed JSON', async () => {
    const event = makePublicEvent();
    (event as { body: string }).body = 'not-json';

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 500 when DynamoDB throws', async () => {
    ddbMock.on(DeleteCommand).rejects(new Error('Service unavailable'));

    const event = makePublicEvent({
      body: { refreshToken: 'some-token' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
  });

});
