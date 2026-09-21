import { createHmac, randomBytes } from "node:crypto";

/**
 * OAuth 1.0a (HMAC-SHA1) request signing for the X API, user context. Four static strings from the
 * developer portal are enough for a single-account bot: no browser flow, no token refresh.
 * JSON and multipart bodies are not part of the signature; only query and form-encoded params are.
 */
export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
}

/** RFC 3986 percent-encoding (encodeURIComponent leaves !*'() alone). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function signatureBaseString(method: string, url: string, params: Array<[string, string]>): string {
  const u = new URL(url);
  const base = `${u.protocol}//${u.host}${u.pathname}`;
  const encoded = params.map(([k, v]) => [percentEncode(k), percentEncode(v)] as const);
  encoded.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const normalized = encoded.map(([k, v]) => `${k}=${v}`).join("&");
  return `${method.toUpperCase()}&${percentEncode(base)}&${percentEncode(normalized)}`;
}

export function sign(baseString: string, consumerSecret: string, tokenSecret: string): string {
  return createHmac("sha1", `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`).update(baseString).digest("base64");
}

export interface SignOptions {
  method: string;
  /** Full URL; its query string is signed. */
  url: string;
  /** application/x-www-form-urlencoded body params, if any. */
  formParams?: Record<string, string>;
  nonce?: string;
  timestamp?: number;
}

export function authorizationHeader(creds: OAuth1Credentials, opts: SignOptions): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const params: Array<[string, string]> = Object.entries(oauth);
  for (const [k, v] of new URL(opts.url).searchParams) params.push([k, v]);
  for (const [k, v] of Object.entries(opts.formParams ?? {})) params.push([k, v]);
  const signature = sign(signatureBaseString(opts.method, opts.url, params), creds.consumerSecret, creds.accessSecret);
  const header = { ...oauth, oauth_signature: signature };
  return `OAuth ${Object.entries(header)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ")}`;
}
