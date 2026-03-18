/**
 * tests/users/login.test.ts
 *
 * Unit tests for the POST /users/login Lambda handler.
 *
 * Testing strategy:
 *   DynamoDB is mocked — no real AWS calls.
 *   bcrypt.compare is mocked — returns true/false per test.
 *   jwt.sign is mocked — returns a predictable token string.
 *   uuid is mocked — predictable refresh token value.
 *
 * What we test:
 *   — Happy path: valid credentials return 200 with accessToken + refreshToken
 *   — Wrong email: user not found → 401 (vague message, no email enumeration)
 *   — Wrong password: bcrypt mismatch → 401 (same vague message)
 *   — Validation failures: invalid email format, missing password → 400
 *   — DynamoDB failure → 500
 *   — passwordHash is stripped from the response
 */

import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { makePublicEvent, TEST_USER } from '../helpers';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-refresh-token') }));

jest.mock('bcryptjs', () => ({
  hash:    jest.fn(),
  compare: jest.fn()
}));

jest.mock('jsonwebtoken', () => ({
  sign:   jest.fn(() => 'mock-access-token'),
  verify: jest.fn()
}));

process.env.USERS_TABLE          = 'test-users-table';
process.env.REFRESH_TOKENS_TABLE = 'test-refresh-tokens-table';
process.env.JWT_SECRET           = 'test-secret';

import { handler } from '../../users/login';
import bcrypt from 'bcryptjs';

// ── DynamoDB mock ─────────────────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  jest.clearAllMocks();
  // Default: password matches
  (bcrypt.compare as jest.Mock).mockResolvedValue(true);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('login handler', () => {

  it('returns 200 with accessToken and refreshToken on valid credentials', async () => {
    // Arrange — user exists and password matches
    ddbMock.on(QueryCommand).resolves({ Items: [TEST_USER], Count: 1 });
    ddbMock.on(PutCommand).resolves({});

    const event = makePublicEvent({
      body: { email: TEST_USER.email, password: 'anypassword' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Login successful');
    expect(body.accessToken).toBe('mock-access-token');
    expect(body.refreshToken).toBe('mock-refresh-token');
    expect(body.user.email).toBe(TEST_USER.email);
    // passwordHash must never be returned
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('stores refresh token in DynamoDB with TTL', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [TEST_USER], Count: 1 });
    ddbMock.on(PutCommand).resolves({});

    const event = makePublicEvent({
      body: { email: TEST_USER.email, password: 'anypassword' }
    });

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: 'test-refresh-tokens-table'
    });

    // Verify the stored item has required fields
    const putCall = ddbMock.commandCalls(PutCommand)[0];
    const item = putCall.args[0].input.Item ?? {};
    expect(item).toMatchObject({
      token:  'mock-refresh-token',
      userId: TEST_USER.userId,
      email:  TEST_USER.email
    });
    // ttl must be a future Unix timestamp
    expect(typeof item['ttl']).toBe('number');
    expect(item['ttl']).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('returns 401 when email is not registered', async () => {
    // User not found in DynamoDB
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    const event = makePublicEvent({
      body: { email: 'notfound@example.com', password: 'anypassword' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    // Vague message — must not reveal that email does not exist
    expect(JSON.parse(result.body).error).toMatch(/invalid email or password/i);
  });

  it('returns 401 when password is wrong', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [TEST_USER], Count: 1 });
    // bcrypt mismatch
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    const event = makePublicEvent({
      body: { email: TEST_USER.email, password: 'wrongpassword' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error).toMatch(/invalid email or password/i);
  });

  it('returns 400 for invalid email format', async () => {
    const event = makePublicEvent({
      body: { email: 'notanemail', password: 'anypassword' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    const event = makePublicEvent({
      body: { email: TEST_USER.email }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 500 when DynamoDB throws', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB error'));

    const event = makePublicEvent({
      body: { email: TEST_USER.email, password: 'anypassword' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
  });

});
