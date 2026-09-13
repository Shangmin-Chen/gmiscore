export class IngestAlreadyRunningError extends Error {
  constructor() {
    super("An ingest run is already in progress for this user.");
    this.name = "IngestAlreadyRunningError";
  }
}
