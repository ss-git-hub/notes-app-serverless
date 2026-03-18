/**
 * notes/update.ts
 *
 * Lambda function — PUT /notes/{id} (protected route)
 *
 * Responsibility: update an existing note's title, content, or tags.
 *
 * This Lambda demonstrates UpdateCommand — the DynamoDB equivalent
 * of Mongoose's findByIdAndUpdate(). The key difference is that
 * DynamoDB requires you to explicitly describe what to update using
 * an UpdateExpression string rather than just passing an object.
 *
 * Key concepts introduced here:
 *   UpdateExpression  — describes which fields to update (like SQL SET)
 *   ConditionExpression — guard that prevents updating non-existent items
 *   ReturnValues: 'ALL_NEW' — returns the full updated item in one round trip
 *
 * Ownership enforcement:
 *   Just like getOne, ownership is enforced by the composite key.
 *   UpdateCommand requires both userId + noteId — if they don't match
 *   an existing item, the ConditionExpression fails and we return 404.
 *
 * Flow:
 * 1. Extract userId from authorizer context
 * 2. Extract noteId from URL path parameters
 * 3. Parse and validate request body
 * 4. Run UpdateCommand with ConditionExpression guard
 * 5. Return the updated note
 *
 * Express equivalent:
 *   router.put('/notes/:id', authMiddleware, async (req, res) => { ... })
 */

import { APIGatewayProxyResult } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import db from '../shared/dynamo';
import { ok, badRequest, notFound, serverError } from '../shared/response';
import { AuthorizedEvent, Note } from '../shared/types';
import { parseBody, updateNoteSchema } from '../shared/validate';

const NOTES_TABLE = process.env.NOTES_TABLE!;

export const handler = async (
  event: AuthorizedEvent
): Promise<APIGatewayProxyResult> => {
  try {

    const { userId } = event.requestContext.authorizer;
    const noteId = event.pathParameters?.id;

    if (!noteId) {
      return badRequest('Note ID is required');
    }

    // ── Parse and validate request body ───────────────────────────
    // updateNoteSchema uses .refine() to enforce that at least one
    // of title, content, or tags is present — preventing empty updates.
    // All three fields are optional individually so partial updates work.
    const parsed = parseBody(event.body, updateNoteSchema);
    if (!parsed.success) return parsed.error;
    const { title, content, tags } = parsed.data;

    // ── UpdateExpression ───────────────────────────────────────────
    // UpdateExpression describes exactly which fields to change.
    // Think of it as the SQL SET clause:
    //   SQL:      UPDATE notes SET title = ?, updatedAt = ? WHERE ...
    //   DynamoDB: UpdateExpression: 'SET title = :t, updatedAt = :ua'
    //
    // We always update updatedAt regardless of what else changed.
    // We only include title, content, tags if they were sent —
    // this way a client can update just the title without
    // accidentally wiping out the content.
    let updateExp = 'SET updatedAt = :ua';
    const expValues: Record<string, unknown> = {
      ':ua': new Date().toISOString()
    };

    if (title) {
      updateExp += ', title = :t';
      expValues[':t'] = title.trim();
    }

    if (content) {
      updateExp += ', content = :c';
      expValues[':c'] = content;
    }

    if (tags) {
      updateExp += ', tags = :tg';
      expValues[':tg'] = tags;
    }

    // ── Run the update ─────────────────────────────────────────────
    // Key: { userId, noteId } — the full composite key.
    // DynamoDB uses this to find the exact item to update.
    // If userId doesn't match (wrong owner) or noteId doesn't exist,
    // the item won't be found and ConditionExpression will fail.
    //
    // ConditionExpression: 'attribute_exists(noteId)'
    // This guard ensures we only update items that actually exist.
    // Without it, DynamoDB would silently create a new empty item
    // if the key didn't exist — not what we want.
    // When this condition fails DynamoDB throws:
    //   ConditionalCheckFailedException → we catch it and return 404
    //
    // ReturnValues: 'ALL_NEW'
    // Returns the complete updated item after the update is applied.
    // Without this we would need a second GetCommand to fetch the
    // updated note — ReturnValues saves us that extra round trip.
    const result = await db.send(new UpdateCommand({
      TableName: NOTES_TABLE,
      Key: { userId, noteId },
      UpdateExpression: updateExp,
      ConditionExpression: 'attribute_exists(noteId)',
      ExpressionAttributeValues: expValues,
      ReturnValues: 'ALL_NEW'
    }));

    return ok({
      message: 'Note updated',
      note: result.Attributes as Note
    });

  } catch (err: unknown) {
    // ConditionalCheckFailedException means either:
    //   — the noteId does not exist
    //   — the userId does not match (wrong owner)
    // We return the same 404 for both — no information leak
    if (
      err instanceof Error &&
      err.name === 'ConditionalCheckFailedException'
    ) {
      return notFound('Note not found');
    }
    console.error('updateNote error:', err);
    return serverError('Could not update note');
  }
};