export class DevAnalyticsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number = 500,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DevAnalyticsError';
  }
}

export class NotFoundError extends DevAnalyticsError {
  constructor(resource: string, id?: string) {
    super(`${resource} not found`, 'not_found', 404, id ? { id } : undefined);
  }
}

export class ForbiddenError extends DevAnalyticsError {
  constructor(message = 'Forbidden', detail?: Record<string, unknown>) {
    super(message, 'forbidden', 403, detail);
  }
}

export class UnauthorizedError extends DevAnalyticsError {
  constructor(message = 'Unauthorized') {
    super(message, 'unauthorized', 401);
  }
}

export class ValidationError extends DevAnalyticsError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message, 'invalid_request', 400, detail);
  }
}

export class RateLimitedError extends DevAnalyticsError {
  constructor(retryAfterSeconds: number) {
    super('Rate limit exceeded', 'rate_limited', 429, { retryAfterSeconds });
  }
}

export class UnsafeQueryError extends DevAnalyticsError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message, 'unsafe_query', 400, detail);
  }
}
