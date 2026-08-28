import {
  RESIDENT_CONTROL_FORMATS,
  decodeCredentialVerifier,
  decodeResidentEnrollmentRequest,
  decodeResidentRotationActivationRequest,
  decodeResidentRotationRequest,
  isResidentControlCodecError,
  parseNodeBearerAuthorization,
  serializeResidentEnrollmentResult,
  serializeResidentRotationResult,
  type ResidentControlBody,
  type ResidentControlErrorCode,
  type InstanceId,
} from '@elpis/gateway-protocol';
import {
  GatewayCredentialError,
  type AuthenticatedNode,
  type EnrollmentReceipt,
  type GatewayCredentialStore,
  type RotationReceipt,
} from './credential-store.js';

export type ResidentControlRoute =
  'enrollment' | 'rotation' | 'rotationActivation';

export interface ResidentControlSuccess {
  readonly status: 200 | 201;
  /** A body serialized by the shared resident-control protocol codec. */
  readonly body: string;
}

export class ResidentControlApiError extends Error {
  readonly status: number;
  readonly code: ResidentControlErrorCode;
  readonly requestId?: string;

  constructor(
    status: number,
    code: ResidentControlErrorCode,
    requestId?: string,
  ) {
    super('resident control request failed');
    this.name = 'ResidentControlApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** The deliberately narrow credential transaction surface used by HTTP. */
export interface ResidentControlCredentialStore {
  enroll(
    input: Parameters<GatewayCredentialStore['enroll']>[0],
  ): EnrollmentReceipt;
  authenticateNode(token: unknown): AuthenticatedNode | null;
  proposeRotation(
    oldToken: unknown,
    newCredentialId: string,
    newVerifier: Uint8Array,
    requestId?: string | null,
  ): RotationReceipt;
  activateRotation(
    newToken: unknown,
    requestId?: string | null,
  ): RotationReceipt;
}

/**
 * Transient proof returned after proposal authorization. Callers must keep it
 * request-local; the adapter never persists or logs the usable credential.
 */
export interface ResidentProposalAuthorization {
  readonly token: string;
}

export interface ResidentControlApi {
  authorizeProposal(authorization: unknown): ResidentProposalAuthorization;
  activationAuthorization(authorization: unknown): string;
  enroll(body: ResidentControlBody): ResidentControlSuccess;
  proposeRotation(
    authorization: ResidentProposalAuthorization,
    body: ResidentControlBody,
  ): ResidentControlSuccess;
  activateRotation(
    token: string,
    body: ResidentControlBody,
  ): ResidentControlSuccess;
}

function failure(
  status: number,
  code: ResidentControlErrorCode,
  requestId?: string,
): never {
  throw new ResidentControlApiError(status, code, requestId);
}

function credentialFailure(
  error: GatewayCredentialError,
  requestId: string,
): never {
  switch (error.code) {
    case 'invalid':
      return failure(401, 'unauthorized', requestId);
    case 'expired':
      return failure(410, 'expired', requestId);
    case 'revoked':
      return failure(403, 'revoked', requestId);
    case 'conflict':
      return failure(409, 'conflict', requestId);
  }
}

function withCredentialMapping<T>(requestId: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof GatewayCredentialError)
      return credentialFailure(error, requestId);
    throw error;
  }
}

function enrollmentSuccess(receipt: EnrollmentReceipt): ResidentControlSuccess {
  return Object.freeze({
    status: receipt.replayed ? 200 : 201,
    body: serializeResidentEnrollmentResult({
      format: RESIDENT_CONTROL_FORMATS.enrollmentResult,
      instanceId: receipt.instanceId as InstanceId,
      credentialId: receipt.credentialId,
      replayed: receipt.replayed,
    }),
  });
}

function rotationSuccess(
  receipt: RotationReceipt,
  created = true,
): ResidentControlSuccess {
  return Object.freeze({
    status: created && !receipt.replayed ? 201 : 200,
    body: serializeResidentRotationResult({
      format: RESIDENT_CONTROL_FORMATS.rotationResult,
      instanceId: receipt.instanceId as InstanceId,
      credentialId: receipt.credentialId,
      previousCredentialId: receipt.previousCredentialId,
      replayed: receipt.replayed,
    }),
  });
}

export class GatewayResidentControlApi implements ResidentControlApi {
  readonly #credentials: ResidentControlCredentialStore;

  constructor(credentials: ResidentControlCredentialStore) {
    if (!credentials || typeof credentials !== 'object')
      throw new Error('resident credential store is required');
    this.#credentials = credentials;
  }

  /** Authenticate the currently active credential before proposal body I/O. */
  authorizeProposal(authorization: unknown): ResidentProposalAuthorization {
    const token = parseNodeBearerAuthorization(authorization);
    if (token === null || this.#credentials.authenticateNode(token) === null)
      return failure(401, 'unauthorized');
    return Object.freeze({ token });
  }

  /** Validate exact bearer syntax; pending proof is checked by activation. */
  activationAuthorization(authorization: unknown): string {
    const token = parseNodeBearerAuthorization(authorization);
    if (token === null) return failure(401, 'unauthorized');
    return token;
  }

  enroll(body: ResidentControlBody): ResidentControlSuccess {
    let input: ReturnType<typeof decodeResidentEnrollmentRequest>;
    try {
      input = decodeResidentEnrollmentRequest(body);
    } catch (error) {
      if (isResidentControlCodecError(error))
        return failure(400, 'invalid_request');
      throw error;
    }
    return withCredentialMapping(input.requestId, () =>
      enrollmentSuccess(
        this.#credentials.enroll({
          grantToken: input.grantToken,
          instanceId: input.instanceId,
          displayName: input.displayName,
          credentialId: input.credentialId,
          credentialVerifier: decodeCredentialVerifier(
            input.credentialVerifier,
          ),
          requestId: input.requestId,
        }),
      ),
    );
  }

  proposeRotation(
    authorization: ResidentProposalAuthorization,
    body: ResidentControlBody,
  ): ResidentControlSuccess {
    let input: ReturnType<typeof decodeResidentRotationRequest>;
    try {
      input = decodeResidentRotationRequest(body);
    } catch (error) {
      if (isResidentControlCodecError(error))
        return failure(400, 'invalid_request');
      throw error;
    }
    return withCredentialMapping(input.requestId, () =>
      rotationSuccess(
        this.#credentials.proposeRotation(
          authorization.token,
          input.credentialId,
          decodeCredentialVerifier(input.credentialVerifier),
          input.requestId,
        ),
      ),
    );
  }

  activateRotation(
    token: string,
    body: ResidentControlBody,
  ): ResidentControlSuccess {
    let input: ReturnType<typeof decodeResidentRotationActivationRequest>;
    try {
      input = decodeResidentRotationActivationRequest(body);
    } catch (error) {
      if (isResidentControlCodecError(error))
        return failure(400, 'invalid_request');
      throw error;
    }
    return withCredentialMapping(input.requestId, () =>
      // activateRotation deliberately authenticates a pending credential and
      // atomically revokes the old credential only after this proof succeeds.
      rotationSuccess(
        this.#credentials.activateRotation(token, input.requestId),
        false,
      ),
    );
  }
}

export function createGatewayResidentControlApi(
  credentials: ResidentControlCredentialStore,
): GatewayResidentControlApi {
  return new GatewayResidentControlApi(credentials);
}

export interface ResidentControlRateLimitInput {
  readonly peerAddress: string;
  readonly route: ResidentControlRoute;
  readonly now: number;
}

export interface ResidentControlRateLimiter {
  allow(input: ResidentControlRateLimitInput): boolean;
}

export interface BoundedResidentControlRateLimiterOptions {
  maxEntries?: number;
  windowMs?: number;
  requestsPerWindow?: number;
}

type RateBucket = { count: number; resetAt: number };

/**
 * Fixed-memory limiter. Keys contain only the direct socket peer and one of
 * three fixed route names; forwarded headers and credentials are never read.
 */
export class BoundedResidentControlRateLimiter implements ResidentControlRateLimiter {
  readonly #maxEntries: number;
  readonly #windowMs: number;
  readonly #requestsPerWindow: number;
  readonly #buckets = new Map<string, RateBucket>();

  constructor(options: BoundedResidentControlRateLimiterOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 1024;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#requestsPerWindow = options.requestsPerWindow ?? 60;
    for (const [label, value] of [
      ['maxEntries', this.#maxEntries],
      ['windowMs', this.#windowMs],
      ['requestsPerWindow', this.#requestsPerWindow],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${label} must be a positive safe integer`);
    }
  }

  allow(input: ResidentControlRateLimitInput): boolean {
    if (
      !input ||
      typeof input.peerAddress !== 'string' ||
      input.peerAddress.length < 1 ||
      input.peerAddress.length > 128 ||
      input.peerAddress.includes('\0') ||
      !['enrollment', 'rotation', 'rotationActivation'].includes(input.route) ||
      !Number.isSafeInteger(input.now) ||
      input.now < 0 ||
      input.now > Number.MAX_SAFE_INTEGER - this.#windowMs
    )
      return false;
    const key = input.peerAddress + '\0' + input.route;
    let bucket = this.#buckets.get(key);
    if (bucket && input.now >= bucket.resetAt) {
      this.#buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      // Expired buckets are harmless to forget and pruning keeps the bound
      // useful without attacker-controlled eviction of a live peer bucket.
      if (this.#buckets.size >= this.#maxEntries) {
        for (const [candidate, value] of this.#buckets) {
          if (input.now >= value.resetAt) this.#buckets.delete(candidate);
        }
      }
      if (this.#buckets.size >= this.#maxEntries) return false;
      this.#buckets.set(key, {
        count: 1,
        resetAt: input.now + this.#windowMs,
      });
      return true;
    }
    if (bucket.count >= this.#requestsPerWindow) return false;
    bucket.count += 1;
    return true;
  }
}
