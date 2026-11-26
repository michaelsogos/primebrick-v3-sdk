// One-shot comment-rewrite sweep, wave 3 (job-schedule) — deleted after use.
const fs = require('fs');
const file = 'src/nats/job-schedule.ts';
let s = fs.readFileSync(file, 'utf8');

function esc(t) {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n');
}
function sub(oldTxt, newTxt) {
  const re = new RegExp(esc(oldTxt));
  if (!re.test(s)) {
    console.error('NOT FOUND: ' + oldTxt.slice(0, 70).replace(/\n/g, '|'));
    process.exit(1);
  }
  s = s.replace(re, newTxt);
}

sub('Custom headers (incl. the L1 client-shield key and the correlation',
    'Custom headers (incl. the publisher User-Agent identity stamp and the correlation');

sub('L1 publisher identity — the schedule declaration was published by an\n   *     enrolled service (its static client-shield key survives the rotating\n   *     secret because it lives outside that scheme).',
    'L1 provenance — the fired message travels in the sealed envelope, which\n   *     only a service holding vault-derived message keys can produce:\n   *     envelope validity IS the publisher proof (A7).');

sub('What it deliberately does NOT check: the arm-time serialized AuthUser\n * and the rotating client-shield secret frozen in the fired headers —\n * both die ~65 minutes after arming (rotation 60m + grace 5m), which\n * would kill every long-lived user-lane schedule. Authorization is',
    'What it deliberately does NOT check: the arm-time serialized AuthUser\n * frozen in the fired headers — permissions attest the arming instant,\n * not the firing one, and a revoked grant must stop the fire. Authorization is');

fs.writeFileSync(file, s);
console.log('job-schedule patched');
