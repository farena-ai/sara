// Every error relay raises or returns is a RelayError with a stable `code`:
//   bad-pattern  router.add() got a pattern it cannot read
//   bad-route    router.add() got a bad method or handler, or the same method and pattern twice
//   bad-status   send() got a status that is not an integer from 100 to 599
//   bad-body     send() got a body that cannot be sent (or a body on a 204/304)
//   bad-headers  headers that are not an object of string (or number) values
//   bad-option   createClient() or a client call got an option it does not know, or a bad value
//   timeout      a client attempt got no response in time
//   failed       a client attempt failed without a response (the target threw)
export class RelayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new RelayError(code, message);
}
