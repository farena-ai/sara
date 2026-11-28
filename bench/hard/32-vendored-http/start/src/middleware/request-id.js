/** Numbers the requests of one app (req-1, req-2, ...) and sets the x-request-id header. */
export function requestIds() {
  let count = 0;
  return async (req, next) => {
    const id = `req-${++count}`;
    req.state.requestId = id;
    const res = await next();
    return res.withHeaders({ 'x-request-id': id });
  };
}
