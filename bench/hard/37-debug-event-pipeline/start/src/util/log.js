// The run log. Every line is "t=<clock ms, 7 digits> <component>: <message>".
// The pipeline never writes to the console itself; callers pass a write function (the CLI's --log).

export function createLog(write, clock) {
  if (!write) return silent;
  const log = (component, message) => {
    write(`t=${String(clock.now()).padStart(7, '0')} ${component}: ${message}\n`);
  };
  log.enabled = true;
  return log;
}

export function silent() {}
silent.enabled = false;
