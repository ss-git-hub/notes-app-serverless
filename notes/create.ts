/**
 * notes/create.ts
 *
 * Lambda function — POST /notes (protected route)
 *
 * Responsibility: create a new note for the authenticated user.
 *
 * This is the first notes Lambda and establishes the pattern
 * all other notes Lambdas follow:
 *   — userId always comes from the authorizer, never from the client
 *   — noteId is always generated server-side with uuidv4()
 *   — both userId and noteId together form the DynamoDB composite key
 *
 * Flow:
 * 1. Extract userId from authorizer context
 * 2. Parse and validate request body
 * 3. Build the note item
 * 4. Save to DynamoDB
 * 5. Return the created note
 *
 * Express equivalent:
 *   router.post('/notes', authMiddleware, async (req, res) => { ... })
 */

import { APIGatewayProxyResult } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import db from '../shared/dynamo';
import { created, serverError } from '../shared/response';
import { AuthorizedEvent, Note } from '../shared/types';
import { parseBody, createNoteSchema } from '../shared/validate';

const NOTES_TABLE = process.env.NOTES_TABLE!;

export const handler = async (
  event: AuthorizedEvent
): Promise<APIGatewayProxyResult> => {
  try {

    // userId comes from the verified JWT via the Lambda Authorizer
    // The client cannot spoof this — it is extracted from the token
    const { userId } = event.requestContext.authorizer;

    // ── Parse and validate request body ───────────────────────────
    // parseBody() handles malformed JSON and Zod validation in one step.
    // createNoteSchema enforces title/content presence, max lengths,
    // and tag array rules (max 10 tags, each max 50 chars).
    // tags defaults to [] if omitted — so we never store undefined in DynamoDB.
    const parsed = parseBody(event.body, createNoteSchema);
    if (!parsed.success) return parsed.error;
    const { title, content, tags = [] } = parsed.data;

    // ── Build note item ────────────────────────────────────────────
    // TypeScript checks this against our Note interface —
    // every required field must be present and correctly typed.
    //
    // Composite key breakdown:
    //   userId  — partition key — groups all notes belonging to this user
    //   noteId  — sort key      — uniquely identifies this note within the user
    //
    // This design means:
    //   — fetching all notes for a user is a single efficient Query by userId
    //   — fetching one specific note requires both userId + noteId
    //   — a user can never accidentally access another user's notes
    //     because the userId is always scoped to their own token
    const note: Note = {
      userId,
      noteId:    uuidv4(),   // server-generated — client never sets this
      title:     title.trim(),
      content,
      tags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // ── Save to DynamoDB ───────────────────────────────────────────
    // PutCommand inserts the item or replaces it if the key exists.
    // ConditionExpression: 'attribute_not_exists(noteId)' prevents
    // replacing an existing note in the astronomically unlikely event
    // of a uuid collision. Defensive programming best practice.
    await db.send(new PutCommand({
      TableName: NOTES_TABLE,
      Item: note,
      ConditionExpression: 'attribute_not_exists(noteId)'
    }));

    return created({ message: 'Note created', note });

  } catch (err) {
    console.error('createNote error:', err);
    return serverError('Could not create note');
  }
};