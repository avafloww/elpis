export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

/** A JSON object owned by the HTTP boundary and frozen before dispatch. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type GatewayApiSuccessStatus = 200 | 201;

export interface GatewayApiResponse {
  status: GatewayApiSuccessStatus;
  body: JsonObject;
}

export type GatewayApiResult = GatewayApiResponse | Promise<GatewayApiResponse>;

export interface BrowserApiReadRoute {
  readonly policy: 'read';
  handle(body: null, publicUrl: string | null): GatewayApiResult;
}

export type BrowserApiMutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface BrowserApiMutationRoute {
  readonly policy: 'mutation';
  /** Optional exact verb for concrete routes; omitted adapters accept any mutation. */
  readonly method?: BrowserApiMutationMethod;
  /** Reject before Origin/CSRF authorization when no public URL is configured. */
  readonly requiresSetup?: true;
  handle(body: JsonObject, publicUrl: string | null): GatewayApiResult;
}

export interface BrowserApiSetupMutationRoute {
  readonly policy: 'setup-mutation';
  /** Optional exact verb for concrete routes; omitted adapters accept any mutation. */
  readonly method?: BrowserApiMutationMethod;
  /** Extract the origin proposed by the one pre-setup mutation. */
  candidatePublicUrl(body: JsonObject): string;
  handle(body: JsonObject, publicUrl: string | null): GatewayApiResult;
}

export type BrowserApiRoute =
  BrowserApiReadRoute | BrowserApiMutationRoute | BrowserApiSetupMutationRoute;

/** Exact route matching is deliberately the adapter's only HTTP-facing input. */
export interface BrowserApi {
  match(method: string, pathname: string): BrowserApiRoute | null;
}

const STABLE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** A bounded, intentionally public business failure from an API handler. */
export class GatewayApiError extends Error {
  readonly status: number;
  readonly stableCode: string;

  constructor(status: number, stableCode: string) {
    if (!Number.isSafeInteger(status) || status < 400 || status > 599)
      throw new TypeError(
        'Gateway API error status must be between 400 and 599',
      );
    if (typeof stableCode !== 'string' || !STABLE_CODE.test(stableCode))
      throw new TypeError(
        'Gateway API error code must be stable lower_snake_case',
      );
    super(stableCode);
    this.name = 'GatewayApiError';
    this.status = status;
    this.stableCode = stableCode;
  }
}
