/**
 * users/register.ts
 *
 * Lambda function — POST /users/register (public route, no authorizer)
 *
 * Responsibility: create a new user account.
 *
 * Flow:
 * 1. Validate input
 * 2. Check email is not already registered (via GSI query)
 * 3. Hash the password with bcrypt
 * 4. Save the new user to DynamoDB
 * 5. Return the user without the passwordHash
 *
 * Express equivalent:
 *   router.post('/register', async (req, res) => { ... })
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import db from '../shared/dynamo';
import { created, conflict, serverError } from '../shared/response';
import { User, SafeUser } from '../shared/types';
import { parseBody, registerSchema } from '../shared/validate';

// Store the table name in a module-level constant
// process.env.USERS_TABLE is set via config/environment.yml
// The ! tells TypeScript "trust me, this will never be undefined at runtime"
const USERS_TABLE = process.env.USERS_TABLE!;

export const handler = async (
  event: APIGatewayProxyEvent  // public route — standard event, no authorizer
): Promise<APIGatewayProxyResult> => {
  try {

    // ── Parse and validate request body ───────────────────────────
    // parseBody() handles two things in one call:
    //   1. JSON.parse — if the body is malformed JSON, returns 400
    //   2. Zod schema — validates types, formats, and lengths, returns 400
    // If parsing fails, parsed.error is a ready-to-return badRequest response.
    // If it succeeds, parsed.data is fully typed — no more manual if checks.
    const parsed = parseBody(event.body, registerSchema);
    if (!parsed.success) return parsed.error;
    const { email, password, name } = parsed.data;

    // ── Check email uniqueness ─────────────────────────────────────
    // We query the email GSI (Global Secondary Index) on the Users table.
    // A GSI lets us query by a field that is not the partition key.
    // Without the GSI we would have to Scan the entire table — very expensive.
    // With the GSI this is a fast, indexed lookup — like a MongoDB index.
    const existing = await db.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'email-index',      // the GSI we defined in resources.yml
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: {
        ':email': email.toLowerCase() // always store and query email as lowercase
      }
    }));

    if (existing.Count && existing.Count > 0) {
      return conflict('Email already registered');
    }

    // ── Hash password ──────────────────────────────────────────────
    // bcrypt.hash(password, saltRounds)
    // saltRounds: 12 is a good balance between security and performance.
    // Higher = more secure but slower. Never store plain text passwords.
    const passwordHash = await bcrypt.hash(password, 12);

    // ── Build user item ────────────────────────────────────────────
    // This is the shape we store in DynamoDB.
    // TypeScript checks this against our User interface —
    // if a field is missing or wrong type, it won't compile.
    const user: User = {
      userId:       uuidv4(),            // generates a unique ID e.g. "550e8400-e29b..."
      email:        email.toLowerCase(),
      name:         name.trim(),
      passwordHash,                      // hashed — never the plain text password
      createdAt:    new Date().toISOString(),
      updatedAt:    new Date().toISOString()
    };

    // ── Save to DynamoDB ───────────────────────────────────────────
    // PutCommand = INSERT in DynamoDB (equivalent to Mongoose's .save())
    // ConditionExpression: 'attribute_not_exists(userId)' is a safety net —
    // it tells DynamoDB to only insert if this userId doesn't already exist.
    // In practice uuidv4 collisions are astronomically unlikely,
    // but this is defensive programming best practice.
    await db.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: user,
      ConditionExpression: 'attribute_not_exists(userId)'
    }));

    // ── Strip passwordHash before responding ───────────────────────
    // Destructure passwordHash into _ (throwaway variable by convention)
    // and spread the rest into safeUser.
    // TypeScript's SafeUser type enforces this — you cannot accidentally
    // return a User where a SafeUser is expected.
    const { passwordHash: _, ...safeUser }: User = user;

    return created({
      message: 'User registered',
      user: safeUser as SafeUser
    });

  } catch (err) {
    console.error('register error:', err); // logs to CloudWatch automatically
    return serverError('Could not register user');
  }
};