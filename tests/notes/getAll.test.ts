/**
 * tests/notes/getAll.test.ts
 *
 * Unit tests for the GET /notes Lambda handler (paginated).
 *
 * Testing strategy:
 *   DynamoDB QueryCommand is mocked.
 *   Pagination is tested by controlling LastEvaluatedKey in mock responses.
 *
 * What we test:
 *   — Happy path: returns notes array, count, and null nextKey on last page
 *   — Pagination: LastEvaluatedKey returned → nextKey is base64-encoded cursor
 *   — Cursor forwarded: lastKey param decoded and sent as ExclusiveStartKey
 *   — Default limit (20) used when no limit is specified
 *   — Custom limit capped at MAX_LIMIT (100)
 *   — Invalid limit (non-number, zero) → 400
 *   — Malformed cursor ignored gracefully (starts from beginning)
 *   — DynamoDB failure → 500
 */

import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { makeAuthorizedEvent, TEST_NOTE } from '../helpers';

// ── Env ───────────────────────────────────────────────────────────────────────

process.env.NOTES_TABLE = 'test-notes-table';

import { handler } from '../../notes/getAll';

// ── DynamoDB mock ─────────────────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Encodes a DynamoDB key object as the base64 cursor the client would send */
function encodeKey(key: Record<string, string>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getAll notes handler', () => {

  it('returns notes, count, and null nextKey on the last page', async () => {
    // No LastEvaluatedKey → this is the last page
    ddbMock.on(QueryCommand).resolves({
      Items: [TEST_NOTE],
      Count: 1
    });

    const event = makeAuthorizedEvent();

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.notes).toHaveLength(1);
    expect(body.count).toBe(1);
    expect(body.nextKey).toBeNull();
  });

  it('returns base64-encoded nextKey when more pages exist', async () => {
    const lastKey = { userId: 'test-user-id', noteId: 'last-note-id' };
    ddbMock.on(QueryCommand).resolves({
      Items: [TEST_NOTE],
      Count: 1,
      LastEvaluatedKey: lastKey
    });

    const event = makeAuthorizedEvent();

    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.nextKey).not.toBeNull();
    // Decode and verify it matches the original key
    const decoded = JSON.parse(Buffer.from(body.nextKey, 'base64').toString('utf-8'));
    expect(decoded).toEqual(lastKey);
  });

  it('forwards lastKey as ExclusiveStartKey to DynamoDB', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    const cursorKey = { userId: 'test-user-id', noteId: 'prev-note-id' };
    const encodedCursor = encodeKey(cursorKey);

    const event = makeAuthorizedEvent({
      queryStringParameters: { lastKey: encodedCursor }
    });

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
      ExclusiveStartKey: cursorKey
    });
  });

  it('uses default limit of 20 when no limit param is provided', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    const event = makeAuthorizedEvent();

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
      Limit: 20
    });
  });

  it('uses the provided limit', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    const event = makeAuthorizedEvent({
      queryStringParameters: { limit: '5' }
    });

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
      Limit: 5
    });
  });

  it('caps limit at 100 when client requests more', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    const event = makeAuthorizedEvent({
      queryStringParameters: { limit: '999' }
    });

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
      Limit: 100
    });
  });

  it('returns 400 when limit is not a number', async () => {
    const event = makeAuthorizedEvent({
      queryStringParameters: { limit: 'abc' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/positive integer/i);
  });

  it('returns 400 when limit is zero or negative', async () => {
    const event = makeAuthorizedEvent({
      queryStringParameters: { limit: '0' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it('ignores a malformed lastKey cursor and starts from the beginning', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    const event = makeAuthorizedEvent({
      queryStringParameters: { lastKey: 'not-valid-base64-json' }
    });

    // Should not throw or return 400 — bad cursor is treated as no cursor
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    // ExclusiveStartKey should be undefined (start from beginning)
    const queryCall = ddbMock.commandCalls(QueryCommand)[0];
    expect(queryCall.args[0].input.ExclusiveStartKey).toBeUndefined();
  });

  it('queries by userId from the authorizer', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    const event = makeAuthorizedEvent({ userId: 'specific-user-id' });

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
      ExpressionAttributeValues: { ':uid': 'specific-user-id' }
    });
  });

  it('returns 500 when DynamoDB throws', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('Table unavailable'));

    const event = makeAuthorizedEvent();

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
  });

});
