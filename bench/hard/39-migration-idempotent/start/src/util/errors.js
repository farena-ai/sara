// Errors the CLI turns into exit codes (docs/CLI.md).

export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 1;
  }
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 3;
  }
}

/** Thrown by the fault hook's torn write (docs/RESUME.md); tests throw their own errors too. */
export class Interrupted extends Error {}
