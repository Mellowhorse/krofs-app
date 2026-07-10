import { normalizeNLPhone } from "./phone.ts";

let pass = 0;
let fail = 0;

function ok(raw: string, expected: string) {
  const r = normalizeNLPhone(raw);
  if (r.ok && r.e164 === expected) pass++;
  else {
    fail++;
    console.error(`FAIL ok("${raw}") -> ${JSON.stringify(r)} (expected ${expected})`);
  }
}
function bad(raw: string) {
  const r = normalizeNLPhone(raw);
  if (!r.ok) pass++;
  else {
    fail++;
    console.error(`FAIL bad("${raw}") -> accepted as ${r.e164}`);
  }
}

ok("0612345678", "+31612345678");
ok("06 12345678", "+31612345678");
ok("06-1234 5678", "+31612345678");
ok("+31612345678", "+31612345678");
ok("0031612345678", "+31612345678");
ok("31612345678", "+31612345678");
ok("(06) 12345678", "+31612345678");
ok("020 1234567", "+31201234567"); // landline, 9 digits after +31

bad("");
bad("   ");
bad("12345");        // no 0/+/31 prefix
bad("0612");         // too short for NL
bad("+3161234567");  // 8 digits after +31
bad("+316123456789"); // 10 digits after +31
bad("abc");

console.log(`phone tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
