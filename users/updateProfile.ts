/**
 * users/updateProfile.ts
 *
 * Lambda function — PUT /users/profile (protected route)
 *
 * Responsibility: update the authenticated user's name and/or password.
 *
 * This is the most complex user Lambda because it handles two
 * different update scenarios in one function:
 *   1. Update name only
 *   2. Update password (requires current password verification first)
 *   3. Update both at the same time
 *
 * It also demonstrates dynamic UpdateExpression building —
 * only updating the fields that were actually sent in the request.
 *
 * Flow:
 * 1. Extract userId from authorizer context
 * 2. Parse request body
 * 3. Dynamically build the DynamoDB UpdateExpression
 * 4. If password change requested — verify current password first
 * 5. Run the update
 * 6. Return updated user without passwordHash
 *
 * Express equivalent:
 *   router.put('/profile', authMiddleware, async (req, res) => { ... })
 */

import { APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import bcrypt from 'bcryptjs';
import db from '../shared/dynamo';
import { ok, badRequest, unauthorized, notFound, serverError } from '../shared/response';
import { AuthorizedEvent, User } from '../shared/types';
import { parseBody, updateProfileSchema } from '../shared/validate';

const USERS_TABLE = process.env.USERS_TABLE!;

export const handler = async (
  event: AuthorizedEvent
): Promise<APIGatewayProxyResult> => {
  try {

    const { userId } = event.requestContext.authorizer;

    // ── Parse and validate request body ───────────────────────────
    // parseBody() handles malformed JSON and runs Zod validation.
    // updateProfileSchema uses .refine() to enforce the cross-field
    // rule "at least name or newPassword must be present" — something
    // a simple per-field check cannot express cleanly on its own.
    const parsed = parseBody(event.body, updateProfileSchema);
    if (!parsed.success) return parsed.error;
    const { name, currentPassword, newPassword } = parsed.data;

    // ── Dynamically build UpdateExpression ────────────────────────
    // In Mongoose you can do: User.findByIdAndUpdate(id, { name })
    // and Mongoose only updates what you pass.
    //
    // In DynamoDB you must build the UpdateExpression string manually.
    // We start with updatedAt (always updated) and add fields
    // only if they were included in the request body.
    //
    // Final UpdateExpression might look like:
    //   'SET updatedAt = :ua, #n = :name'
    //   'SET updatedAt = :ua, passwordHash = :ph'
    //   'SET updatedAt = :ua, #n = :name, passwordHash = :ph'
    let updateExp = 'SET updatedAt = :ua';

    // ExpressionAttributeValues maps the placeholder variables
    // (e.g. :ua, :name) to their actual values.
    // DynamoDB uses placeholders to avoid conflicts with reserved words
    // and to safely pass values without SQL-injection style risks.
    const expValues: Record<string, string> = {
      ':ua': new Date().toISOString()
    };

    // ExpressionAttributeNames maps placeholder names (e.g. #n)
    // to actual DynamoDB attribute names.
    // 'name' is a reserved word in DynamoDB so we cannot use it
    // directly in an expression — we must alias it as #n.
    const expNames: Record<string, string> = {};

    // ── Add name to update if provided ────────────────────────────
    if (name) {
      updateExp += ', #n = :name';
      expValues[':name'] = name.trim();
      expNames['#n'] = 'name'; // #n → 'name' (reserved word workaround)
    }

    // ── Handle password change if requested ───────────────────────
    if (newPassword) {

      // Current password is required to change password —
      // prevents someone with a stolen token from changing the password
      if (!currentPassword) {
        return badRequest(
          'currentPassword is required to set a new password'
        );
      }

      // Fetch the current user to get their stored passwordHash
      // We need this to verify currentPassword against it
      const current = await db.send(new GetCommand({
        TableName: USERS_TABLE,
        Key: { userId }
      }));

      if (!current.Item) {
        return notFound('User not found');
      }

      // Verify the current password before allowing the change
      // If this check wasn't here, anyone with a valid token could
      // change the password without knowing the current one
      const valid = await bcrypt.compare(
        currentPassword,
        (current.Item as User).passwordHash
      );

      if (!valid) {
        return unauthorized('Current password is incorrect');
      }

      // Hash the new password before storing
      const newHash = await bcrypt.hash(newPassword, 12);
      updateExp += ', passwordHash = :ph';
      expValues[':ph'] = newHash;
    }

    // ── Run the DynamoDB update ────────────────────────────────────
    // UpdateCommand updates only the fields in UpdateExpression.
    // All other fields remain exactly as they were — DynamoDB
    // does not overwrite the whole item like a PUT would.
    //
    // ConditionExpression: 'attribute_exists(userId)'
    // This acts as a guard — the update only runs if the user exists.
    // If not, DynamoDB throws ConditionalCheckFailedException
    // which we catch below and return a 404.
    //
    // ReturnValues: 'ALL_NEW' — returns the full updated item
    // so we can send it back in the response without a second query.
    const result = await db.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId },
      UpdateExpression: updateExp,
      ConditionExpression: 'attribute_exists(userId)',
      // Only include ExpressionAttributeNames if we actually
      // have aliases — passing an empty object causes a DynamoDB error
      ExpressionAttributeNames: Object.keys(expNames).length
        ? expNames
        : undefined,
      ExpressionAttributeValues: expValues,
      ReturnValues: 'ALL_NEW'
    }));

    // ── Strip passwordHash before responding ───────────────────────
    const { passwordHash: _, ...safeUser } =
      result.Attributes as User;

    return ok({ message: 'Profile updated', user: safeUser });

  } catch (err: unknown) {
    // err is typed as unknown — TypeScript forces us to check
    // the type before accessing properties on it.
    // This is safer than catch (err: any) which gives no protection.
    if (
      err instanceof Error &&
      err.name === 'ConditionalCheckFailedException'
    ) {
      return notFound('User not found');
    }
    console.error('updateProfile error:', err);
    return serverError('Could not update profile');
  }
};