/**
 * Story-API REST client errors.
 * `StoryApiNotFoundError` for 404; `StoryApiError` for everything else.
 * `IncompleteDKGNetworkError` for non-Active/Ended rounds where the keeper
 * omits stage-conditional fields.
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

/**
 * Thrown by `decodeDKGNetwork` when the keeper response omits one or more
 * stage-conditional fields. The keeper does not populate `global_public_key`,
 * `public_coeffs`, etc. for rounds in non-stable stages (Registration=1,
 * Dealing=2, Finalization=3, Failed=5). Callers that may query historical
 * or in-progress rounds should catch this and branch on stage; callers that
 * only ever read Active(4)/Ended(6) rounds will never see it in practice.
 */
export class IncompleteDKGNetworkError extends Error {
  readonly round: number;
  readonly stage: number;
  readonly missingFields: readonly string[];
  constructor(round: number, stage: number, missingFields: readonly string[]) {
    super(
      `DKG round ${round} (stage=${stage}) response is missing fields: ` +
        `${missingFields.join(", ")}. The keeper omits these for non-Active/Ended stages.`,
    );
    this.name = "IncompleteDKGNetworkError";
    this.round = round;
    this.stage = stage;
    this.missingFields = missingFields;
  }
}
