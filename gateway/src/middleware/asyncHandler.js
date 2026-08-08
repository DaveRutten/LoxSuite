// Express 4 does not catch a rejection thrown out of an async route handler the way it catches a
// synchronous throw — an un-awaited/uncaught rejection in an async handler just hangs the request
// forever instead of surfacing as a 500, since Express has no idea a promise was even involved.
// Wrap every route handler that's `async` in this so a thrown/rejected error reaches Express's own
// error-handling middleware exactly the way a synchronous throw already does. (Express 5 fixes this
// natively; upgrading is a separate decision from the DB-backend async conversion this exists for.)
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
