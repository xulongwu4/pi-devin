import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { encodeString, iterFields } from "./wire.js";

// Protocol extracted from the Devin CLI (Rust, chisel-api/src/auth/pkce.rs).
// Login: PKCE + localhost callback + Connect unary proto exchange, same
// framing as GetUserJwt. Request/response field numbers follow the nearby
// seat_management PKCE messages (code=1, code_verifier=2, redirect_uri=3;
// session token / api_key = field 1).

export const LOGIN_PATH = "/auth/cli/continue";
export const EXCHANGE_PATH =
  "/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode";
export const DEFAULT_WEBAPP_HOST = "https://app.devin.ai";
export const DEFAULT_API_SERVER = "https://server.codeium.com";

const COMPLETE_HTML =
  "<html><body style=\"font-family: sans-serif\"><h1>Authentication Complete</h1><p>You may close this window.</p></body></html>";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildLoginUrl(
  redirectUri: string,
  challenge: string,
  state: string,
  webappHost = DEFAULT_WEBAPP_HOST,
): string {
  const params = new URLSearchParams({
    cli_pkce_marker: "1",
    response_type: "code",
    redirect_uri: redirectUri,
    redirect_parameters_type: "query",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    prompt: "select_account",
  });
  return `${webappHost.replace(/\/$/, "")}${LOGIN_PATH}?${params}`;
}

export interface CallbackServer {
  redirectUri: Promise<string>;
  code: Promise<string>;
  close(): void;
}

export function startCallbackServer(expectedState: string, signal: AbortSignal): CallbackServer {
  let server: Server | null = null;
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => (resolvePort = resolve));
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const onAbort = () => {
    close();
    rejectCode(new Error("Devin login aborted"));
  };
  const close = () => {
    signal.removeEventListener("abort", onAbort);
    server?.close();
    server = null;
  };
  signal.addEventListener("abort", onAbort, { once: true });

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url.searchParams.get("state") !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>Error: Invalid state parameter</h1></body></html>");
      rejectCode(new Error("PKCE callback state mismatch"));
      close();
      return;
    }
    const got = url.searchParams.get("code");
    if (!got) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>Error: No authorization code received</h1></body></html>");
      rejectCode(new Error("PKCE callback: no authorization code"));
      close();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(COMPLETE_HTML);
    resolveCode(got);
    close();
  });
  server.on("error", (error) => {
    rejectCode(error instanceof Error ? error : new Error(String(error)));
    close();
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server?.address();
    resolvePort(typeof address === "object" && address !== null ? address.port : 0);
  });

  return {
    redirectUri: port.then((p) => `http://127.0.0.1:${p}/callback`),
    code,
    close,
  };
}

export interface DevinExchange {
  apiKey: string;
  apiServerUrl?: string;
}

export function encodeExchangeRequest(code: string, verifier: string, redirectUri: string): Buffer {
  return Buffer.concat([
    encodeString(1, code),
    encodeString(2, verifier),
    encodeString(3, redirectUri),
  ]);
}

export function decodeExchangeResponse(buf: Buffer): DevinExchange {
  let apiKey = "";
  let apiServerUrl: string | undefined;
  for (const field of iterFields(buf)) {
    if (field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    const value = field.value.toString("utf8");
    if (!value) continue;
    // Field 1 is session_token (ExchangeDevinCode) or api_key (ExchangePKCEAuthorizationCode).
    if (field.num === 1) apiKey = value;
    // Field 3 is api_server_url on the Windsurf PKCE response.
    if (field.num === 3 && /^https?:\/\//i.test(value)) apiServerUrl = value;
  }
  if (!apiKey) throw new Error("PKCE exchange returned no session token");
  return { apiKey, apiServerUrl };
}

export async function exchangePkceCode(
  code: string,
  verifier: string,
  redirectUri: string,
  apiServerUrl = DEFAULT_API_SERVER,
  signal?: AbortSignal,
): Promise<DevinExchange> {
  const response = await fetch(`${apiServerUrl.replace(/\/$/, "")}${EXCHANGE_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
    },
    body: new Uint8Array(encodeExchangeRequest(code, verifier, redirectUri)),
    signal,
  });
  const buf = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`PKCE exchange HTTP ${response.status}: ${buf.toString("utf8").slice(0, 240)}`);
  }
  return decodeExchangeResponse(buf);
}
