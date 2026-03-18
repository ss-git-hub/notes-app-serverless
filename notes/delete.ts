/**
 * notes/delete.ts
 *
 * Lambda function — DELETE /notes/{id} (protected route)
 *
 * Responsibility: delete a note by its noteId.
 *
 * This is the final Lambda and the simplest of the notes operations.
 * It follows the exact same ownership enforcement pattern as getOne
 * and update — the composite key (userId + noteId) ensures a user
 * can only delete their own notes.
 *
 * DeleteCommand vs UpdateCommand:
 *   DeleteCommand removes the entire item from the table.
 *   It also supports ConditionExpression — so we can guard against
 *   deleting something that does not exist, same as update.
 *
 * Flow:
 * 1. Extract userId from authorizer context
 * 2. Extract noteId from URL path parameters
 * 3. Delete the note using the composite key
 * 4. Return 404 if not found, success message if deleted
 *
 * Express equivalent:
 *   router.delete('/notes/:id', authMiddleware, async (req, res) => { ... })
 */

import { APIGatewayProxyResult } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import db from '../shared/dynamo';
import { ok, badRequest, notFound, serverError } from '../shared/response';
import { AuthorizedEvent } from '../shared/types';

const NOTES_TABLE = process.env.NOTES_TABLE!;

export const handler = async (
  event: AuthorizedEvent
): Promise<APIGatewayProxyResult> => {
  try {

    const { userId } = event.requestContext.authorizer;

    // ── Extract noteId from path parameters ───────────────────────
    // Same pattern as getOne and update.
    // DELETE /notes/abc-123 → event.pathParameters.id = 'abc-123'
    const noteId = event.pathParameters?.id;

    if (!noteId) {
      return badRequest('Note ID is required');
    }

    // ── Delete the note ────────────────────────────────────────────
    // DeleteCommand removes the item identified by the composite key.
    //
    // Key: { userId, noteId }
    //   userId — ensures we are operating within the correct user's partition
    //   noteId — identifies the exact note to delete
    //
    // If the client sends a noteId that belongs to a different user,
    // DynamoDB looks for { theirUserId + thatNoteId } — which does not
    // exist in the table — so ConditionExpression fails and we 404.
    // Ownership is enforced without any extra code.
    //
    // ConditionExpression: 'attribute_exists(noteId)'
    //   Prevents silent no-op deletes.
    //   Without this, deleting a non-existent noteId would succeed
    //   silently — DynamoDB would just do nothing and return success.
    //   With this condition, we get ConditionalCheckFailedException
    //   which we catch and return as a proper 404.
    await db.send(new DeleteCommand({
      TableName: NOTES_TABLE,
      Key: { userId, noteId },
      ConditionExpression: 'attribute_exists(noteId)'
    }));

    // No need to return the deleted item — just confirm it was deleted.
    // The client already has the note data since they had to display
    // it before they could choose to delete it.
    return ok({ message: 'Note deleted' });

  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === 'ConditionalCheckFailedException'
    ) {
      return notFound('Note not found');
    }
    console.error('deleteNote error:', err);
    return serverError('Could not delete note');
  }
};