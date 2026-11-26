// One-shot comment-rewrite sweep, wave 2 — deleted after use (temp file).
const fs = require('fs');
let total = 0;

function esc(t) {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n');
}
function patch(file, subs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [oldTxt, newTxt] of subs) {
    const re = new RegExp(esc(oldTxt));
    if (!re.test(s)) {
      console.error('NOT FOUND in ' + file + ': ' + oldTxt.slice(0, 70).replace(/\n/g, '|'));
      process.exit(1);
    }
    s = s.replace(re, newTxt);
    total++;
  }
  fs.writeFileSync(file, s);
}

patch('src/nats/nats-routes.ts', [
  // :76 — NatsRouteContext.user docstring
  ['service-authenticated routes (`verify` shield check) — services have',
   'service-lane routes (`verify` service check) — services have'],
  // :90 — NatsRouteVerify docstring
  ['`undefined` → caller verified, no user (service-to-BE shield identity)',
   '`undefined` → caller verified, no user (service-to-service lane identity)'],
  // :120 — verify option docstring
  ['Service-identity verification (e.g. BE client-shield check) instead of',
   'Service-identity verification (service-lane check) instead of'],
  // :127 — enrollment docstring
  ["client-shield check entirely (it must do the equivalent check itself,",
   "caller-verification layer entirely (it must do the equivalent check itself,"],
  // :152 — durable docstring
  ['capturing exactly this subject and wires the same shield/RBAC/contract',
   'capturing exactly this subject and wires the same verify/RBAC/contract'],
  // :237 — A7 comment: shield at HTTP edge
  ['(stronger than a cleartext stamp). The shield stays at the HTTP edge,\n  // where the threat model is real. RBAC and route.verify are unchanged.\n  // Layer 2 — caller verification: custom service-auth hook, or the\n  // default client-shield-secret + AuthUser + RBAC chain.',
   '(stronger than a cleartext stamp). Provenance verification stays at the\n  // HTTP edge, where the threat model is real. RBAC and route.verify are\n  // unchanged.\n  // Layer 2 — caller verification: custom service-auth hook, or the\n  // default AuthUser + RBAC chain.'],
  // :255 — durable wiring docstring
  ['core path (shield → verify/RBAC → contract parse → handler), consumed',
   'core path (verify/RBAC → contract parse → handler), consumed'],
  // :535 — callNats identity stamp
  ["// Stamp service identity (UA + shield key) — the BE's verifyPublisher\n    // check depends on it. Identity is applied AFTER caller headers so it\n    // can never be overridden. No-op until configureInternalClient() runs.",
   '// Stamp service identity (User-Agent) — observability attribution on\n    // every hop. Identity is applied AFTER caller headers so it can never\n    // be overridden. No-op until configureInternalClient() runs.'],
]);

patch('src/nats/nats-client.ts', [
  ["Stamp the caller's service identity (User-Agent + client shield key)",
   "Stamp the caller's service identity (User-Agent)"],
]);

patch('src/nats/message-envelope.ts', [
  ['job correlation ids, shield stamps) stays in cleartext NATS headers.',
   'job correlation ids, identity stamps) stays in cleartext NATS headers.'],
]);

const JOB_LANE_OLD = `system-lane dispatch carries NO user context and NO client-shield
  // secret (run_as:"system" arms headers-free — the rotating secret is
  // never frozen), so \`verify: serviceLaneVerify\` replaces the default
  // verifyNatsMessage L2 chain: the L1 client-shield enrollment is the
  // gate, exactly as \`dueLaneVerify("system")\` defines the lane.`;
const JOB_LANE_NEW = `system-lane dispatch carries NO user context (run_as:"system"
  // arms headers-free), so \`verify: serviceLaneVerify\` replaces the default
  // verifyNatsMessage L2 chain: the sealed-envelope provenance is the gate,
  // exactly as \`dueLaneVerify("system")\` defines the lane.`;

patch('src/microservice/partition-maintenance-job.ts', [[JOB_LANE_OLD, JOB_LANE_NEW]]);
patch('src/microservice/sequence-revive-job.ts', [[JOB_LANE_OLD, JOB_LANE_NEW]]);

patch('src/microservice/create-microservice.ts', [
  ["callNats (config.get, service.register): the BE's shield check re",
   "callNats (config.get, service.register): the BE's provenance verification reads"],
  // fix the trailing fragment of that sentence
  ['these headers.\n  // Resolve service coordinates EARLY',
   'the provenance headers of every call.\n  // Resolve service coordinates EARLY'],
  ['serviceCode; every callNats (client_shield_registry.get, secret.g',
   'serviceCode; every callNats (config.get, secret.g'],
]);

patch('src/secrets/secret-vault.ts', [
  ['legitimate for Redis-distributed shield\n * secrets, but a banned channel for vault material.',
   'legitimate for Redis-distributed shared\n * secrets, but a banned channel for vault material.'],
]);

patch('src/service/service-lifecycle-subjects.ts', [
  ['it forms the canonical identity `{pkg_name}/{version}` (ua_prefix in\n   * system.client_shield_registry, service_registry.pkg_name, log messages).',
   'it forms the canonical identity `{pkg_name}/{version}`\n   * (service_registry.pkg_name, log messages).'],
]);

patch('src/service/service-registrar.ts', [
  ['always carry real identity (it feeds system.client_shield_registry).',
   'always carry real identity (it feeds service_registry).'],
]);

console.log('wave2 patched:', total);
