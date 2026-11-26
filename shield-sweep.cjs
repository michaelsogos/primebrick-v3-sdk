// One-shot comment-rewrite sweep — deleted after use (temp file).
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

// ─── wave 1: auth / docs-pack / http ───

patch('src/http/internal-client.ts', [
  ["caller's service-identity headers (User-Agent + x-primebrick-client-shield-key)",
   "caller's service-identity header (the User-Agent stamp — observability identity; trust itself is proof-of-possession, applied below)"],
]);

patch('src/auth/mfa-step-up.ts', [
  ['governed correlation route `auth.mfa.consume` (client-shield only, the',
   'governed correlation route `auth.mfa.consume` (service-lane only, the'],
]);

patch('src/auth/permissions.ts', [
  ['/** Endpoint reachable anonymously. STILL requires client-shield-secret in GATEWAY mode. */',
   '/** Endpoint reachable anonymously — no user context required. */'],
]);

patch('src/auth/session-context.ts', [
  ['`isSystem`, so the call must ALWAYS be additionally gated by the client',
   '`isSystem`, so the call must ALWAYS travel the governed fabric — the'],
  ['shield (it is — verifyNatsPublisher runs first on every governed route).',
   'sealed envelope (NATS) / provenance signature (HTTP) IS the proof, and a user-less service cannot forge it.'],
]);

patch('src/docs-pack/docs-pack-client.ts', [
  ["Uses `internalFetch`, so the caller's service-identity headers",
   "Uses `internalFetch`, so the caller's User-Agent identity stamp is always"],
  ['(User-Agent + client-shield key) are always attached — the only legal',
   'attached and the request carries proof-of-possession provenance — the only legal'],
  ['* Additionally stamps the rotating client-shield secret: the BE',
   '* The BE'],
  ["'s pack\n * route (a service-to-service endpoint without user context) is gated by\n * that secret, which the secret engine provisions to every consumer.",
   "'s pack\n * route (a service-to-service endpoint without user context) is gated by that\n * provenance verification at the transport edge."],
]);

patch('src/docs-pack/serve-docs-pack.ts', [
  ['service, not a user — the real gate is the B11 client-identity shield',
   'service, not a user — the real gate is the internal-provenance verification'],
  ['in `createHttpServer` (User-Agent registry check + client-shield key),',
   'in `createHttpServer` (proof-of-possession of vault-derived keys),'],
]);

patch('src/http/openapi.ts', [
  ['callers authenticate with their client shield key, which is exactly how',
   'callers authenticate with proof-of-possession provenance, which is exactly how'],
]);

patch('src/auth/auth-user-serializer.ts', [
  ['to a standard set. The gateway secret header is always added for\n * anti-spoofing.',
   'to a standard set. Anti-spoofing is NOT a transmitted secret: the internal\n * funnel seals these headers into the AES-GCM blob and signs the request\n * proof-of-possession — no secret ever rides the wire.'],
  ['to microservices (HTTP proxy or NATS). Also includes the gateway secret\n * header for anti-spoofing.',
   'to microservices (HTTP proxy or NATS). No secret is included — provenance\n * is proof-of-possession, applied by the transport funnel.'],
  [' * The gateway secret is verified separately by verifyAuthGatewayResolved().',
   ' * Anti-spoofing is the proof-of-possession provenance verified at the\n * transport edge before this chain runs — there is no secret to verify.'],
]);

patch('src/auth/verify-nats.ts', [
  ['the full AuthUser into NATS headers, the subscriber verifies the gateway secret\n * and deserializes the AuthUser. NO ports needed.',
   'the full AuthUser into NATS headers, the subscriber deserializes it —\n * anti-spoofing is the sealed-envelope provenance, not a shared secret.\n * NO ports needed.'],
  ['serializeAuthUserToHeaders() and adds the gateway secret.',
   'serializeAuthUserToHeaders() — no secret is added; provenance is the sealed envelope.'],
  ['Wraps serializeAuthUserToHeaders() — includes gateway secret for anti-spoofing.',
   'Wraps serializeAuthUserToHeaders() — anti-spoofing is the sealed-envelope\n * provenance, not a transmitted secret.'],
]);

patch('src/http/http-server.ts', [
  ['of vault-derived keys, never a transmitted secret. The registry still\n      // lives for NATS publisher attribution only (verifyNatsPublisher).',
   'of vault-derived keys, never a transmitted secret. The shield registry\n      // is gone entirely — publisher attribution on NATS is the sealed envelope.'],
]);

console.log('wave1 patched:', total);
