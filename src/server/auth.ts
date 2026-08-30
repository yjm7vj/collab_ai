/**
 * Token minting, token verification, and random id generation.
 *
 * This is the whole trust boundary for room access, so it deliberately does one
 * thing: HMAC-SHA-256 over a JSON payload, with WebCrypto and nothing else. No
 * dependencies, no Node built-ins, no JWT library — the token shape is fixed and
 * small enough that a library would add surface without adding safety.
 *
 * A token proves only that this server issued it and that it has not expired.
 * Every caller must still re-check the claims against current room state: roles
 * change and members get removed while a token is still cryptographically valid.
 */

export type TokenClaims = {
  /** Room this token is valid for. A token for one room is useless in another. */
  rid: string;
  /** Durable member id. */
  uid: string;
  /** Role at the moment of issue. Always re-check against the member record. */
  role: string;
  /** Optional signed-in profile avatar; never a secret. */
  avatar?: string;
  /** Expiry, in Unix SECONDS (not milliseconds). */
  exp: number;
};

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";

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

function base64UrlDecodeToString(value: string): string {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  if (padding === 2) {
    base64 += "==";
  } else if (padding === 3) {
    base64 += "=";
  } else if (padding !== 0) {
    throw new Error("invalid base64url length");
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function base64UrlDecodeToBytes(value: string): Uint8Array<ArrayBuffer> {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  if (padding === 2) {
    base64 += "==";
  } else if (padding === 3) {
    base64 += "=";
  } else if (padding !== 0) {
    throw new Error("invalid base64url length");
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function mintToken(secret: string, claims: TokenClaims): Promise<string> {
  const payload = base64UrlEncodeString(JSON.stringify(claims));
  const key = await hmacKey(secret);
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  const signature = base64UrlEncode(signatureBytes);
  return `${payload}.${signature}`;
}

export async function verifyToken(
  secret: string,
  token: string,
  nowSeconds?: number,
): Promise<TokenClaims | null> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;

  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = base64UrlDecodeToBytes(signature);
  } catch {
    return null;
  }

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(payload),
  );
  if (!valid) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecodeToString(payload));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.rid !== "string") return null;
  if (typeof candidate.uid !== "string") return null;
  if (typeof candidate.role !== "string") return null;
  if (typeof candidate.exp !== "number" || !Number.isFinite(candidate.exp)) return null;

  if (candidate.exp <= now) return null;

  return {
    rid: candidate.rid,
    uid: candidate.uid,
    role: candidate.role,
    ...(typeof candidate.avatar === "string" ? { avatar: candidate.avatar } : {}),
    exp: candidate.exp,
  };
}

export function newId(length = 22): string {
  const B62_THRESHOLD = 248; // largest multiple of 62 that fits in a byte
  let result = "";
  const buffer = new Uint8Array(1);
  while (result.length < length) {
    crypto.getRandomValues(buffer);
    const byte = buffer[0]!;
    if (byte >= B62_THRESHOLD) continue;
    result += B62[byte % 62];
  }
  return result;
}

export function newInviteCode(): string {
  const CODE_THRESHOLD = 224; // largest multiple of 56 that fits in a byte
  let result = "";
  const buffer = new Uint8Array(1);
  while (result.length < 10) {
    crypto.getRandomValues(buffer);
    const byte = buffer[0]!;
    if (byte >= CODE_THRESHOLD) continue;
    result += CODE_ALPHABET[byte % 56];
  }
  return result;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
