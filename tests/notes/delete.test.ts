/**
 * tests/notes/delete.test.ts
 *
 * Unit tests for the DELETE /notes/{id} Lambda handler.
 *
 * Testing strategy:
 *   DynamoDB DeleteCommand is mocked.
 *   ConditionalCheckFailedException simulates a missing or mis-owned note.
 *
 * What we test:
 *   — Happy path: note exists → 200 with success message
 *   — Missing noteId in path parameters → 400
 *   — Note not found (ConditionalCheckFailedException) → 404
 *   — Ownership enforced: different userId + noteId → 404 (same error)
 *   — DynamoDB failure → 500
 */

import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { makeAuthorizedEvent, TEST_NOTE } from '../helpers';

// ── Env ───────────────────────────────────────────────────────────────────────

process.env.NOTES_TABLE = 'test-notes-table';

import { handler } from '../../notes/delete';

// ── DynamoDB mock ─────────────────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeCondCheckError(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

beforeEach(() => {
  ddbMock.reset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('delete note handler', () => {

  it('returns 200 with success message when note is deleted', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    const event = makeAuthorizedEvent({
      pathParameters: { id: TEST_NOTE.noteId }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).message).toMatch(/deleted/i);
  });

  it('calls DeleteCommand with the composite key', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    const event = makeAuthorizedEvent({
      userId: TEST_NOTE.userId,
      pathParameters: { id: TEST_NOTE.noteId }
    });

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
      TableName: 'test-notes-table',
      Key: { userId: TEST_NOTE.userId, noteId: TEST_NOTE.noteId }
    });
  });

  it('returns 400 when noteId is missing from path parameters', async () => {
    const event = makeAuthorizedEvent();
    // No pathParameters set → id is undefined

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/note id/i);
  });

  it('returns 404 when note does not exist', async () => {
    ddbMock.on(DeleteCommand).rejects(makeCondCheckError());

    const event = makeAuthorizedEvent({
      pathParameters: { id: 'nonexistent-note-id' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toMatch(/not found/i);
  });

  it('returns 404 when noteId belongs to a different user (ownership enforced)', async () => {
    // DynamoDB looks for { differentUserId + noteId } which does not exist → ConditionCheck fails
    ddbMock.on(DeleteCommand).rejects(makeCondCheckError());

    const event = makeAuthorizedEvent({
      userId: 'different-user-id',
      pathParameters: { id: TEST_NOTE.noteId }
    });

    const result = await handler(event);

    // Same 404 as not found — no information leak about who owns the note
    expect(result.statusCode).toBe(404);
  });

  it('returns 500 when DynamoDB throws an unexpected error', async () => {
    ddbMock.on(DeleteCommand).rejects(new Error('Internal error'));

    const event = makeAuthorizedEvent({
      pathParameters: { id: TEST_NOTE.noteId }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
  });

});
