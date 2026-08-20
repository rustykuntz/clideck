function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// A local child connecting to a specific interface bind has matching source
// and destination addresses rather than a loopback source.
function isSameHost(req) {
  const normalize = addr => addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  const remote = normalize(req.socket?.remoteAddress || '');
  const local = normalize(req.socket?.localAddress || '');
  return remote === '::1'
    || remote === '127.0.0.1'
    || remote.startsWith('127.')
    || (!!remote && !!local && remote === local);
}

function sameProject(a, b) {
  return (a.projectId || null) === (b.projectId || null);
}

function projectName(projects, projectId) {
  if (!projectId) return 'No project';
  return projects.find(p => p.id === projectId)?.name || projectId;
}

function sessionAddress(session, id, projects) {
  const name = session.name || id.slice(0, 8);
  return session.projectId ? `@${projectName(projects, session.projectId)}/${name}` : name;
}

module.exports = { sendJson, isSameHost, sameProject, projectName, sessionAddress };
