/**
 * tests/notes/create.test.ts
 *
 * Unit tests for the POST /notes Lambda handler.
 *
 * Testing strategy:
 *   DynamoDB PutCommand is mocked.
 *   uuid is mocked for a predictable noteId.
 *   The handler uses AuthorizedEvent — makeAuthorizedEvent() provides userId.
 *
 * What we test:
 *   — Happy path: valid input creates a note and returns 201
 *   — userId comes from the authorizer (never from the request body)
 *   — Optional tags: note created without tags defaults to []
 *   — Validation: missing title → 400, title too long → 400, too many tags → 400
 *   — DynamoDB failure → 500
 */

import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { makeAuthorizedEvent } from '../helpers';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-note-id') }));

process.env.NOTES_TABLE = 'test-notes-table';

import { handler } from '../../notes/create';

// ── DynamoDB mock ─────────────────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('create note handler', () => {

  it('returns 201 with the created note', async () => {
    ddbMock.on(PutCommand).resolves({});

    const event = makeAuthorizedEvent({
      body: { title: 'My Note', content: 'Some content', tags: ['aws'] }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Note created');
    expect(body.note.noteId).toBe('mock-note-id');
    expect(body.note.title).toBe('My Note');
    expect(body.note.tags).toEqual(['aws']);
  });

  it('sets userId from the authorizer, not the request body', async () => {
    ddbMock.on(PutCommand).resolves({});

    const event = makeAuthorizedEvent({
      userId: 'authorizer-user-id',
      body: { title: 'Title', content: 'Content' }
    });

    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.note.userId).toBe('authorizer-user-id');
  });

  it('defaults tags to empty array when omitted', async () => {
    ddbMock.on(PutCommand).resolves({});

    const event = makeAuthorizedEvent({
      body: { title: 'Title', content: 'Content' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.note.tags).toEqual([]);
  });

  it('trims whitespace from title', async () => {
    ddbMock.on(PutCommand).resolves({});

    const event = makeAuthorizedEvent({
      body: { title: '  Padded Title  ', content: 'Content' }
    });

    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.note.title).toBe('Padded Title');
  });

  it('returns 400 when title is missing', async () => {
    const event = makeAuthorizedEvent({
      body: { content: 'Some content' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when title exceeds 100 characters', async () => {
    const event = makeAuthorizedEvent({
      body: { title: 'a'.repeat(101), content: 'Content' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/100/);
  });

  it('returns 400 when more than 10 tags are provided', async () => {
    const event = makeAuthorizedEvent({
      body: { title: 'Title', content: 'Content', tags: Array(11).fill('tag') }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/10 tags/i);
  });

  it('stores the note in the correct DynamoDB table', async () => {
    ddbMock.on(PutCommand).resolves({});

    const event = makeAuthorizedEvent({
      body: { title: 'Title', content: 'Content' }
    });

    await handler(event);

    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: 'test-notes-table'
    });
  });

  it('returns 500 when DynamoDB throws', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB error'));

    const event = makeAuthorizedEvent({
      body: { title: 'Title', content: 'Content' }
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
  });

});
