/**
 * tests/notes/update.test.ts
 *
 * Unit tests for the PUT /notes/{id} Lambda handler.
 *
 * Testing strategy:
 *   DynamoDB UpdateCommand is mocked.
 *   ConditionalCheckFailedException is simulated to test 404 responses.
 *
 * What we test:
 *   — Happy path: valid partial update returns 200 with updated note
 *   — Missing noteId in path parameters → 400
 *   — Empty body (no fields provided) → 400 via .refine() rule
 *   — Note not found (ConditionalCheckFailedException) → 404
 *   — DynamoDB failure → 500
 *   — Only provided fields are included in UpdateExpression
 */

import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { makeAuthorizedEvent, TEST_NOTE } from '../helpers';

// ── Env ───────────────────────────────────────────────────────────────────────

process.env.NOTES_TABLE = 'test-notes-table';

import { handler } from '../../notes/update';

// ── DynamoDB mock ─────────────────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

// Error that DynamoDB throws when ConditionExpression fails
function makeCondCheckError(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

beforeEach(() => {
  ddbMock.reset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('update note handler', () => {

  it('returns 200 with the updated note on a valid partial update', async () => {
    const updatedNote = { ...TEST_NOTE, title: 'Updated Title' };
    ddbMock.on(UpdateCommand).resolves({ Attributes: updatedNote });

    const event = makeAuthorizedEvent({
      pathParameters: { id: TEST_NOTE.noteId },
      body: { title: 'Updated Title' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Note updated');
    expect(body.note.title).toBe('Updated Title');
  });

  it('returns 200 when updating only tags', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...TEST_NOTE, tags: ['new-tag'] }
    });

    const event = makeAuthorizedEvent({
      pathParameters: { id: TEST_NOTE.noteId },
      body: { tags: ['new-tag'] }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
  });

  it('returns 400 when noteId is missing from path parameters', async () => {
    const event = makeAuthorizedEvent({
      body: { title: 'New Title' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/note id/i);
  });

  it('returns 400 when body has no fields (violates .refine() rule)', async () => {
    const event = makeAuthorizedEvent({
      pathParameters: { id: TEST_NOTE.noteId },
      body: {}
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/at least/i);
  });

  it('returns 404 when note does not exist or belongs to another user', async () => {
    ddbMock.on(UpdateCommand).rejects(makeCondCheckError());

    const event = makeAuthorizedEvent({
      pathParameters: { id: 'nonexistent-note-id' },
      body: { title: 'New Title' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toMatch(/not found/i);
  });

  it('uses both userId and noteId as the composite key', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: TEST_NOTE });

    const event = makeAuthorizedEvent({
      userId: TEST_NOTE.userId,
      pathParameters: { id: TEST_NOTE.noteId },
      body: { title: 'New Title' }
    });

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      Key: { userId: TEST_NOTE.userId, noteId: TEST_NOTE.noteId }
    });
  });

  it('always includes updatedAt in the UpdateExpression', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: TEST_NOTE });

    const event = makeAuthorizedEvent({
      pathParameters: { id: TEST_NOTE.noteId },
      body: { content: 'New content' }
    });

    await handler(event);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    const updateExp: string = updateCall.args[0].input.UpdateExpression ?? '';
    expect(updateExp).toMatch(/updatedAt/);
    expect(updateExp).toMatch(/content/);
  });

  it('returns 500 when DynamoDB throws an unexpected error', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('Connection reset'));

    const event = makeAuthorizedEvent({
      pathParameters: { id: TEST_NOTE.noteId },
      body: { title: 'New Title' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
  });

});
