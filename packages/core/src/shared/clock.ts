/** Wall-clock time, supplied by the host so behavior is testable and explicit. */
export interface Clock {
  now(): Date;
}
