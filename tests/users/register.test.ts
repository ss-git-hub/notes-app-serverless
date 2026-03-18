/**
 * tests/users/register.test.ts
 *
 * Unit tests for the POST /users/register Lambda handler.
 *
 * Testing strategy:
 *   DynamoDB is mocked with aws-sdk-client-mock — no real AWS calls.
 *   bcrypt is mocked — no real hashing (fast, deterministic).
 *   uuid is mocked — predictable IDs in assertions.
 *
 * What we test:
 *   — Happy path: valid input creates a user and returns 201
 *   — Email conflict: existing email returns 409
 *   — Validation failures: invalid email, short password, missing name → 400
 *   — DynamoDB failure: unexpected error returns 500
 *   — Password hash is never included in the response
 */

import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { makePublicEvent, TEST_USER } from '../helpers';

// ── Mock external dependencies before importing the handler ──────────────────

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid-register') }));

jest.mock('bcryptjs', () => ({
  hash:    jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn()
}));

// Set required env vars before the module is loaded
process.env.USERS_TABLE = 'test-users-table';

// Import handler AFTER mocks are set up
import { handler } from '../../users/register';

// ── DynamoDB mock ─────────────────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('register handler', () => {

  it('returns 201 and safe user on valid input', async () => {
    // Arrange — email does not exist yet, PutCommand succeeds
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });
    ddbMock.on(PutCommand).resolves({});

    const event = makePublicEvent({
      body: { email: 'new@example.com', password: 'password123', name: 'Alice' }
    });

    // Act
    const result = await handler(event);

    // Assert — 201 Created with user data (no passwordHash)
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('User registered');
    expect(body.user.email).toBe('new@example.com');
    expect(body.user.name).toBe('Alice');
    // passwordHash must never be returned to the client
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('lowercases the email before storing it', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });
    // Capture what was passed to PutCommand
    ddbMock.on(PutCommand).callsFake((input) => {
      expect(input.Item.email).toBe('upper@example.com');
      return {};
    });

    const event = makePublicEvent({
      body: { email: 'UPPER@example.com', password: 'password123', name: 'Bob' }
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(201);
  });

  it('returns 409 when email is already registered', async () => {
    // Arrange — GSI query returns an existing user
    ddbMock.on(QueryCommand).resolves({ Items: [TEST_USER], Count: 1 });

    const event = makePublicEvent({
      body: { email: TEST_USER.email, password: 'password123', name: 'Alice' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error).toMatch(/already registered/i);
  });

  it('returns 400 for invalid email format', async () => {
    const event = makePublicEvent({
      body: { email: 'not-an-email', password: 'password123', name: 'Alice' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/email/i);
  });

  it('returns 400 for password shorter than 8 characters', async () => {
    const event = makePublicEvent({
      body: { email: 'user@example.com', password: 'short', name: 'Alice' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/8 characters/i);
  });

  it('returns 400 when name is missing', async () => {
    const event = makePublicEvent({
      body: { email: 'user@example.com', password: 'password123' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for malformed JSON body', async () => {
    // makePublicEvent sets body as a JSON string — override to raw string
    const event = makePublicEvent();
    (event as { body: string }).body = '{bad json';

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/valid JSON/i);
  });

  it('returns 500 when DynamoDB throws an unexpected error', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('Network timeout'));

    const event = makePublicEvent({
      body: { email: 'user@example.com', password: 'password123', name: 'Alice' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
  });

  it('calls DynamoDB PutCommand with the correct table name', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });
    ddbMock.on(PutCommand).resolves({});

    const event = makePublicEvent({
      body: { email: 'user@example.com', password: 'password123', name: 'Alice' }
    });

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: 'test-users-table'
    });
  });

});
