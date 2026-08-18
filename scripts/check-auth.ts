/**
 * Guard checks for the access-token primitives. These are the only thing
 * standing between a forged token and a private room.
 *
 * Run: npx esbuild scripts/check-auth.ts --bundle --format=esm --platform=node --outfile=node_modules/.cache/check-auth.mjs --log-level=warning && node node_modules/.cache/check-auth.mjs
 */
import {
  type TokenClaims,
  constantTimeEqual,
  mintToken,
  newId,
  newInviteCode,
  verifyToken,
} from "../src/server/auth";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

// Same base64url + HMAC recipe as src/server/auth.ts, used here only to hand-craft
// tokens that mintToken() would never produce (garbage payload, wrong secret, etc.)
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

async function signRaw(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return base64UrlEncode(sig);
}

async function main() {
  const SECRET = "correct-horse-battery-staple";
  const OTHER_SECRET = "a-totally-different-secret";

  console.log("\ntoken round trip");
  {
    const claims: TokenClaims = { rid: "room1", uid: "user1", role: "owner", exp: 9999999999 };
    const token = await mintToken(SECRET, claims);
    const verified = await verifyToken(SECRET, token, 1000);
    check("mint then verify returns equal claims", JSON.stringify(verified) === JSON.stringify(claims), verified);

    const farFuture: TokenClaims = { rid: "room2", uid: "user2", role: "member", exp: 99999999999 };
    const farToken = await mintToken(SECRET, farFuture);
    const farVerified = await verifyToken(SECRET, farToken, 1000);
    check("exp far in the future verifies", farVerified !== null, farVerified);
  }

  console.log("\ntoken forgery");
  {
    const claims: TokenClaims = { rid: "room1", uid: "user1", role: "owner", exp: 9999999999 };
    const token = await mintToken(SECRET, claims);

    const wrongSecret = await verifyToken(OTHER_SECRET, token, 1000);
    check("different secret returns null", wrongSecret === null, wrongSecret);

    const [payload, signature] = token.split(".") as [string, string];
    const tamperedPayloadChar = payload[0] === "a" ? "b" : "a";
    const tamperedPayload = tamperedPayloadChar + payload.slice(1);
    const tamperedPayloadToken = `${tamperedPayload}.${signature}`;
    const tamperedPayloadResult = await verifyToken(SECRET, tamperedPayloadToken, 1000);
    check("tampered payload returns null", tamperedPayloadResult === null, tamperedPayloadResult);

    const tamperedSigChar = signature[0] === "a" ? "b" : "a";
    const tamperedSig = tamperedSigChar + signature.slice(1);
    const tamperedSigToken = `${payload}.${tamperedSig}`;
    const tamperedSigResult = await verifyToken(SECRET, tamperedSigToken, 1000);
    check("tampered signature returns null", tamperedSigResult === null, tamperedSigResult);

    const otherClaims: TokenClaims = { rid: "room-other", uid: "user1", role: "owner", exp: 9999999999 };
    const otherToken = await mintToken(OTHER_SECRET, otherClaims);
    const [otherPayload] = otherToken.split(".") as [string, string];
    const swappedToken = `${otherPayload}.${signature}`;
    const swappedResult = await verifyToken(SECRET, swappedToken, 1000);
    check("swapped payload from different rid/secret returns null", swappedResult === null, swappedResult);
  }

  console.log("\ntoken malformed input");
  {
    check("empty string returns null", (await verifyToken(SECRET, "", 1000)) === null);
    check("no dot returns null", (await verifyToken(SECRET, "abc", 1000)) === null);
    check("three parts returns null", (await verifyToken(SECRET, "a.b.c", 1000)) === null);
    check("empty payload returns null", (await verifyToken(SECRET, ".sig", 1000)) === null);
    check("empty signature returns null", (await verifyToken(SECRET, "payload.", 1000)) === null);

    const garbagePayload = base64UrlEncodeString("not valid json {{{");
    const garbageSig = await signRaw(SECRET, garbagePayload);
    const garbageToken = `${garbagePayload}.${garbageSig}`;
    const garbageResult = await verifyToken(SECRET, garbageToken, 1000);
    check("correctly signed invalid JSON payload returns null", garbageResult === null, garbageResult);

    const numericUidPayload = base64UrlEncodeString(
      JSON.stringify({ rid: "room1", uid: 42, role: "owner", exp: 9999999999 }),
    );
    const numericUidSig = await signRaw(SECRET, numericUidPayload);
    const numericUidToken = `${numericUidPayload}.${numericUidSig}`;
    const numericUidResult = await verifyToken(SECRET, numericUidToken, 1000);
    check("numeric uid returns null", numericUidResult === null, numericUidResult);
  }

  console.log("\ntoken expiry");
  {
    const now = 1000;
    const expNow: TokenClaims = { rid: "room1", uid: "user1", role: "owner", exp: now };
    const tokenExpNow = await mintToken(SECRET, expNow);
    check("exp exactly equal to now returns null", (await verifyToken(SECRET, tokenExpNow, now)) === null);

    const expPast: TokenClaims = { rid: "room1", uid: "user1", role: "owner", exp: now - 1 };
    const tokenExpPast = await mintToken(SECRET, expPast);
    check("exp one second in the past returns null", (await verifyToken(SECRET, tokenExpPast, now)) === null);

    const expFuture: TokenClaims = { rid: "room1", uid: "user1", role: "owner", exp: now + 1 };
    const tokenExpFuture = await mintToken(SECRET, expFuture);
    const expFutureResult = await verifyToken(SECRET, tokenExpFuture, now);
    check("exp one second in the future verifies", expFutureResult !== null, expFutureResult);
  }

  console.log("\nnewId");
  {
    const id = newId();
    check("default length is 22", id.length === 22, id.length);

    const id40 = newId(40);
    check("newId(40) has length 40", id40.length === 40, id40.length);

    const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let allValid = true;
    for (let i = 0; i < 200; i++) {
      const generated = newId();
      for (const ch of generated) {
        if (!B62.includes(ch)) allValid = false;
      }
    }
    check("every character of 200 generated ids is in the B62 alphabet", allValid);

    const idSet = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      idSet.add(newId());
    }
    check("2000 generated ids are all distinct", idSet.size === 2000, idSet.size);
  }

  console.log("\nnewInviteCode");
  {
    const code = newInviteCode();
    check("length is exactly 10", code.length === 10, code.length);

    const forbidden = new Set(["0", "1", "I", "O", "l", "o"]);
    let clean = true;
    const codes: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const c = newInviteCode();
      codes.push(c);
      for (const ch of c) {
        if (forbidden.has(ch)) clean = false;
      }
    }
    check("none of 2000 codes contain ambiguous characters", clean);

    const codeSet = new Set(codes);
    check("2000 codes are all distinct", codeSet.size === 2000, codeSet.size);
  }

  console.log("\nconstantTimeEqual");
  {
    check("equal strings are true", constantTimeEqual("hello", "hello") === true);
    check("same-length different strings are false", constantTimeEqual("hello", "hxllo") === false);
    check("different-length strings are false", constantTimeEqual("hello", "hell") === false);
    check("two empty strings are true", constantTimeEqual("", "") === true);
  }

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
