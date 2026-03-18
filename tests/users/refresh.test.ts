/**
 * tests/users/refresh.test.ts
 *
 * Unit tests for the POST /users/refresh Lambda handler.
 *
 * Testing strategy:
 *   DynamoDB GetCommand is mocked to return/not return a refresh token item.
 *   jwt.sign is mocked — returns a predictable access token.
 *   The manual TTL check (storedToken.ttl < nowInSeconds) is tested by
 *   controlling the ttl value in the mock return data.
 *
 * What we test:
 *   — Happy path: valid non-expired token → 200 with new accessToken
 *   — Token not found in DynamoDB → 401
 *   — Token found but TTL is in the past → 401
 *   — Missing refreshToken field → 400
 *   — DynamoDB failure → 500
 */

import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { makePublicEvent, TEST_USER } from '../helpers';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('jsonwebtoken', () => ({
  sign:   jest.fn(() => 'new-access-token'),
  verify: jest.fn()
}));

process.env.REFRESH_TOKENS_TABLE = 'test-refresh-tokens-table';
process.env.JWT_SECRET           = 'test-secret';

import { handler } from '../../users/refresh';

// ── DynamoDB mock ─────────────────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

// A valid refresh token item stored in DynamoDB — TTL 7 days from now
const VALID_REFRESH_TOKEN = {
  token:     'valid-refresh-token-uuid',
  userId:    TEST_USER.userId,
  email:     TEST_USER.email,
  ttl:       Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  createdAt: '2026-01-01T00:00:00.000Z'
};

beforeEach(() => {
  ddbMock.reset();
  jest.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('refresh handler', () => {

  it('returns 200 with a new accessToken for a valid refresh token', async () => {
    ddbMock.on(GetCommand).resolves({ Item: VALID_REFRESH_TOKEN });

    const event = makePublicEvent({
      body: { refreshToken: 'valid-refresh-token-uuid' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Token refreshed');
    expect(body.accessToken).toBe('new-access-token');
  });

  it('looks up the refresh token by its UUID key', async () => {
    ddbMock.on(GetCommand).resolves({ Item: VALID_REFRESH_TOKEN });

    const event = makePublicEvent({
      body: { refreshToken: 'valid-refresh-token-uuid' }
    });

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(GetCommand, {
      TableName: 'test-refresh-tokens-table',
      Key: { token: 'valid-refresh-token-uuid' }
    });
  });

  it('returns 401 when refresh token is not found in DynamoDB', async () => {
    // GetCommand returns no item — token was never issued or already deleted
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = makePublicEvent({
      body: { refreshToken: 'unknown-token' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error).toMatch(/invalid or expired/i);
  });

  it('returns 401 when refresh token TTL is in the past', async () => {
    // TTL is 1 hour ago — DynamoDB might not have deleted it yet (48h window)
    const expiredToken = {
      ...VALID_REFRESH_TOKEN,
      ttl: Math.floor(Date.now() / 1000) - 3600
    };
    ddbMock.on(GetCommand).resolves({ Item: expiredToken });

    const event = makePublicEvent({
      body: { refreshToken: 'expired-token' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error).toMatch(/expired/i);
  });

  it('returns 400 when refreshToken field is missing', async () => {
    const event = makePublicEvent({
      body: {}
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 500 when DynamoDB throws', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB unavailable'));

    const event = makePublicEvent({
      body: { refreshToken: 'some-token' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
  });

  it('uses userId and email from the stored token to sign the new JWT', async () => {
    const jwt = require('jsonwebtoken');
    ddbMock.on(GetCommand).resolves({ Item: VALID_REFRESH_TOKEN });

    const event = makePublicEvent({
      body: { refreshToken: 'valid-refresh-token-uuid' }
    });

    await handler(event);

    expect(jwt.sign).toHaveBeenCalledWith(
      { userId: TEST_USER.userId, email: TEST_USER.email },
      'test-secret',
      { expiresIn: '15m' }
    );
  });

});
