/**
 * authorizer/handler.ts
 *
 * Lambda Authorizer — the JWT middleware equivalent for AWS Lambda.
 *
 * How it works:
 * 1. A request hits API Gateway
 * 2. API Gateway calls THIS Lambda first (before your route Lambda)
 * 3. This Lambda verifies the JWT token
 * 4. If valid   → returns an IAM Allow policy + user context
 * 5. If invalid → throws Unauthorized — API Gateway blocks the request
 * 6. If allowed → API Gateway calls your route Lambda and passes the
 *                 user context via event.requestContext.authorizer
 *
 * The result is cached by API Gateway for 5 minutes by default,
 * meaning repeated requests with the same token don't re-invoke
 * this Lambda every time — good for performance.
 *
 * Express equivalent:
 *   const authMiddleware = (req, res, next) => {
 *     const decoded = jwt.verify(token, secret);
 *     req.user = decoded;
 *     next();
 *   }
 */

import {
  APIGatewayTokenAuthorizerEvent,
  APIGatewayAuthorizerResult
} from 'aws-lambda';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../shared/types';

/**
 * APIGatewayTokenAuthorizerEvent — the event shape AWS passes to a
 * Lambda Authorizer. It contains:
 *   event.authorizationToken — the raw "Bearer <token>" header value
 *   event.methodArn          — the ARN of the API Gateway method being called
 *                              used as the Resource in the IAM policy we return
 *
 * APIGatewayAuthorizerResult — the shape AWS expects us to return.
 * Unlike Express where you just call next(), here we must return
 * a full IAM policy document. AWS reads this to decide Allow or Deny.
 */
export const verify = async (
  event: APIGatewayTokenAuthorizerEvent
): Promise<APIGatewayAuthorizerResult> => {

  // Extract the token from the Authorization header
  // Header format is: "Bearer eyJhbGciOiJIUzI1NiJ9..."
  // We split on space and take the second part
  const token = event.authorizationToken?.split(' ')[1];

  // If there is no token at all, throw immediately
  // API Gateway expects this exact error string for a 401 response
  if (!token) throw new Error('Unauthorized');

  try {
    // Verify the token signature and expiry using our secret
    // If the token is expired or tampered with, jwt.verify throws
    // which is caught below and returns a Deny policy
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET!  // pulled from SSM at deploy time
    ) as JwtPayload;

    // Token is valid — return an Allow policy
    // We also pass userId and email as context so route Lambdas
    // can access them via event.requestContext.authorizer
    //
    // Use a wildcard resource instead of event.methodArn so the cached
    // policy covers ALL routes in this stage, not just the one that
    // triggered this authorizer invocation.
    //
    // methodArn format: arn:aws:execute-api:region:account:api-id/stage/METHOD/path
    // We keep only the first two segments (api-id/stage) and add /*/* to
    // allow any method and any path — e.g. GET /notes/{id}, POST /notes, etc.
    // Without this, a policy cached for GET /notes would block GET /notes/{id}
    // because the cached resource doesn't cover the new path.
    const [arnPrefix, stage] = event.methodArn.split('/');
    const wildcardArn = `${arnPrefix}/${stage}/*/*`;

    return generatePolicy(
      decoded.userId,
      'Allow',
      wildcardArn,
      decoded
    );

  } catch {
    // Token is invalid or expired — throw Unauthorized
    // API Gateway will return a 401 to the client
    // The route Lambda never runs
    throw new Error('Unauthorized');
  }
};

/**
 * generatePolicy
 *
 * Builds the IAM policy document that API Gateway requires.
 *
 * In Express auth middleware you call next() to allow or return 401 to deny.
 * In Lambda Authorizer you return an IAM policy with Effect: Allow or Deny.
 * AWS reads this policy to decide whether to proceed with the request.
 *
 * The context object is how you pass data to the route Lambda —
 * equivalent to attaching data to req.user in Express middleware.
 * Whatever you put in context appears in
 * event.requestContext.authorizer inside the route Lambda.
 *
 * Note: context values must be strings, numbers, or booleans —
 * not nested objects. That's why we pass userId and email as
 * flat strings rather than passing the whole decoded JWT payload.
 */
const generatePolicy = (
  principalId: string,           // identifies the user — we use userId
  effect: 'Allow' | 'Deny',     // whether to allow or block the request
  resource: string,              // the API Gateway method ARN being accessed
  ctx: Partial<JwtPayload> = {}  // data to pass through to the route Lambda
): APIGatewayAuthorizerResult => ({
  principalId,
  policyDocument: {
    Version: '2012-10-17',       // IAM policy version — always this value
    Statement: [{
      Action: 'execute-api:Invoke',  // permission to invoke API Gateway
      Effect: effect,
      Resource: resource             // which specific endpoint is being accessed
    }]
  },
  // context passes verified user data to the route Lambda
  // accessible via event.requestContext.authorizer.userId
  context: {
    userId: ctx.userId ?? '',
    email:  ctx.email  ?? ''
  }
});