Refactor this callback pyramid to async/await, preserving error behavior:
getUser(id, (err, u) => { if (err) cb(err); else getOrders(u.id, (err, o) => { if (err) cb(err); else render(u, o, cb); }); });
