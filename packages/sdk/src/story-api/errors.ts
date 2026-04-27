/**
 * Story-API REST client errors.
 * `StoryApiNotFoundError` for 404; `StoryApiError` for everything else.
 */

export class StoryApiNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryApiNotFoundError";
  }
}

export class StoryApiError extends Error {
  readonly status: number;
  readonly code?: number;
  constructor(status: number, message: string, code?: number) {
    super(message);
    this.name = "StoryApiError";
    this.status = status;
    this.code = code;
  }
}
