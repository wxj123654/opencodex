import { gzipSync, gunzipSync } from "node:zlib";
import { consumeConnectFrames, encodeConnectFrame, MAX_CONNECT_FRAME_PAYLOAD_BYTES } from "../connect-framing";
import { redactSecretString } from "../../lib/redact";
import {
  decodeCliModelConfigs,
  decodeGetChatMessageResponse,
  decodeGetUserJwtResponse,
  encodeGetChatMessageRequest,
  encodeGetUserJwtRequest,
  type CliModelConfig,
  type GetChatMessageRequest,
  type Metadata,
} from "./proto";

/**
 * Transport for the Devin/Cascade Connect API.
 *
 * ## The wire
 *
 * Everything here is connectrpc over HTTP/1.1 with protobuf message bodies. Two RPCs matter:
 *
 *   - `GetUserJwt` (`application/proto`) exchanges the stored session token for a short-lived
 *     per-user JWT, then optionally hands back a custom API host when the account is pinned to a
 *     regional deployment.
 *   - `GetChatMessage` (`application/connect+proto`) is the streaming chat call. Request and
 *     response are both sequences of Connect frames; the request is sent gzip-compressed inside a
 *     single frame, and each response frame is a `GetChatMessageResponse` delta.
 *
 * `GetCliModelConfigs` (plain protobuf) supplies the entitlement-aware model roster.
 *
 * ## Why the identity fields are hard-coded
 *
 * `Metadata` declares which Windsurf client is calling. Cascade is the shared Windsurf/Devin
 * backend, and those IDE version strings are what the published client reports, so they are part
 * of the request contract rather than configuration a user should be able to change — a wrong
 * value is not a preference, it is a malformed handshake.
 *
 * ## Reverse-engineered and therefore volatile
 *
 * None of this is a documented public API. Field numbers and paths were verified against the live
 * service on 2026-09-12 (devin 3000.10.21). A server-side protocol change breaks this adapter the
 * same way it would break any other client of a private endpoint, and the failure mode to expect is
 * a decode or an `invalid_argument`, not a clean version error.
 */

export const DEVIN_CASCADE_BASE_URL = "https://server.codeium.com";

const GET_USER_JWT_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

/** The Windsurf client identity the RPCs expect. Not configurable; see the module comment. */
const IDE_NAME = "windsurf";
const IDE_VERSION = "3.2.23";
const EXTENSION_VERSION = "1.48.2";

const AUTH_TIMEOUT_MS = 30_000;
const DEFAULT_UPSTREAM_IDLE_MS = 120_000;

/** Frame payload ceiling. A response frame larger than this is a protocol failure, not a big turn. */
const MAX_FRAME_PAYLOAD = Math.min(MAX_CONNECT_FRAME_PAYLOAD_BYTES, 16 * 1024 * 1024);

/**
 * Cascade's own end-of-turn sentinels.
 *
 * The model was trained to continue a chat transcript, so without these it will happily write the
 * USER's next line for them. The API has no turn-stop field, only these substring patterns.
 */
const DEFAULT_STOP_PATTERNS = ["\n\nUSER:", "\n\nASSISTANT:", "<|context_request|>", "<|end_of_turn|>"];

export function buildDevinMetadata(apiKey: string, userJwt?: string): Metadata {
  return {
    ideName: IDE_NAME,
    ideVersion: IDE_VERSION,
    extensionName: IDE_NAME,
    extensionVersion: EXTENSION_VERSION,
    apiKey,
    locale: "en",
    userJwt,
  };
}

export interface DevinHttpDeps {
  /** Injected fetch, so tests drive the adapter without a network and the proxy's pacing seam applies. */
  fetch?: typeof globalThis.fetch;
  /** Test seam for the per-turn clock; production leaves this unset. */
  now?: () => number;
  /** Replaces the random cascade/execution ids, so a test can assert exact request bytes. */
  randomId?: () => string;
  /** Ceiling on silence from the upstream stream before aborting, re-armed per frame. */
  upstreamIdleMs?: number;
}

/**
 * Bun accepts a `Uint8Array` request body; TypeScript's DOM `BodyInit` omits that runtime shape.
 * Same cast, and same reason, as the Cursor HTTP/1.1 bridge.
 */
function binaryBody(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit;
}

function decodeErrorMessage(payload: Uint8Array): string {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as {
      code?: string;
      message?: string;
      error?: { code?: string; message?: string };
    };
    const code = parsed.code ?? parsed.error?.code;
    const message = parsed.message ?? parsed.error?.message;
    if (code || message) return [code, message].filter(Boolean).join(": ");
  } catch {
    /* not JSON; fall through to raw text */
  }
  return new TextDecoder().decode(payload).slice(0, 512);
}

export class DevinHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DevinHttpError";
  }
}

/**
 * Exchange the session token for a per-user JWT.
 *
 * The response is normally plain protobuf, but a gzip-compressed body has been observed, so a
 * decode failure is retried against the gunzipped bytes rather than surfacing as a corrupt-credential
 * error.
 */
export async function fetchUserJwt(
  apiKey: string,
  deps: DevinHttpDeps = {},
  baseUrl: string = DEVIN_CASCADE_BASE_URL,
  abortSignal?: AbortSignal,
): Promise<{ userJwt: string; baseUrl: string }> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(AUTH_TIMEOUT_MS);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;

  const response = await doFetch(`${baseUrl.replace(/\/+$/, "")}${GET_USER_JWT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      accept: "*/*",
    },
    body: binaryBody(encodeGetUserJwtRequest(buildDevinMetadata(apiKey))),
    signal,
  });

  const payload = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new DevinHttpError(
      `Devin auth failed (${response.status}): ${decodeErrorMessage(payload)}`,
      response.status,
    );
  }

  let decoded;
  try {
    decoded = decodeGetUserJwtResponse(payload);
  } catch {
    decoded = decodeGetUserJwtResponse(gunzipSync(payload));
  }

  if (!decoded.userJwt) {
    throw new DevinHttpError("Devin auth returned an empty user JWT.", 502);
  }

  const custom = decoded.customApiServerUrl.trim();
  return {
    userJwt: decoded.userJwt,
    baseUrl: custom ? custom.replace(/\/+$/, "") : baseUrl,
  };
}

// ─── Streaming chat ─────────────────────────────────────────────────────────

export interface DevinChatParams {
  apiKey: string;
  userJwt: string;
  baseUrl?: string;
  modelUid: string;
  systemPrompt: string;
  request: Omit<GetChatMessageRequest, "metadata" | "chatModelUid" | "prompt">;
  signal?: AbortSignal;
}

/**
 * One decoded delta from the chat stream.
 *
 * `endStreamError` is separate from `done` on purpose: Cascade terminates every stream with an
 * end-stream frame whose absence of an `error` field means success, so a stream can end "cleanly"
 * at the transport level and still carry a terminal failure from the model.
 */
export type DevinStreamEvent =
  | { type: "delta"; text: string; thinking: string; thinkingSignature: string; signatureType: string }
  | { type: "toolcalls"; calls: Array<{ id: string; name: string; argumentsJson: string; invalidJsonErr?: string }> }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; modelUid?: string }
  | { type: "stop"; stopReason: number }
  | { type: "done" }
  | { type: "protocolError"; message: string }
  | { type: "endStreamError"; code: string; message: string };

/**
 * Stream one chat turn.
 *
 * ## Usage frames arrive mostly empty
 *
 * The server attaches a usage message to nearly every frame, and all but the last are zeroed. The
 * caller must therefore treat usage as "last non-zero wins" rather than accumulating — this
 * generator forwards every observed usage frame and lets the adapter decide, because a zeroed frame
 * is also the only signal that the field was present at all.
 *
 * ## Tool calls arrive complete
 *
 * Unlike OpenAI's streaming contract, `deltaToolCalls` entries are whole calls on first sight, not
 * argument fragments. The adapter therefore emits start+delta+end for each call immediately instead
 * of accumulating deltas.
 */
export async function* streamDevinChat(
  params: DevinChatParams,
  deps: DevinHttpDeps = {},
): AsyncGenerator<DevinStreamEvent> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const baseUrl = (params.baseUrl ?? DEVIN_CASCADE_BASE_URL).replace(/\/+$/, "");
  const idleMs = deps.upstreamIdleMs ?? DEFAULT_UPSTREAM_IDLE_MS;

  const body = encodeGetChatMessageRequest({
    ...params.request,
    metadata: buildDevinMetadata(params.apiKey, params.userJwt),
    chatModelUid: params.modelUid,
    prompt: params.systemPrompt,
  });

  // The request is one gzip-compressed Connect frame. `connect-content-encoding: gzip` tells the
  // server the frame body is compressed; the in-frame 0x01 flag repeats it for the frame parser.
  const compressed = gzipSync(body);
  const frame = encodeConnectFrame(compressed, { compressed: true });

  const controller = new AbortController();
  const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal;

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    // Re-armed on every received frame, so a long but active stream is never cut off — only real
    // silence trips it. Without this a stalled upstream would hold the turn until the client
    // disconnects, which reads as a hang rather than an error.
    idleTimer = setTimeout(() => controller.abort(new Error("upstream idle")), idleMs);
  };

  let response: Response;
  try {
    armIdle();
    response = await doFetch(`${baseUrl}${CHAT_MESSAGE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/connect+proto",
        "connect-protocol-version": "1",
        "connect-content-encoding": "gzip",
        "connect-accept-encoding": "gzip",
        "accept-encoding": "identity",
      },
      body: binaryBody(frame),
      signal,
    });
  } catch (error) {
    clearTimeout(idleTimer);
    if (controller.signal.aborted) {
      yield { type: "protocolError", message: `Devin stream produced no response within ${Math.round(idleMs / 1000)}s.` };
      return;
    }
    throw error;
  }

  if (!response.ok) {
    clearTimeout(idleTimer);
    const payload = new Uint8Array(await response.arrayBuffer());
    const detail = redactSecretString(decodeErrorMessage(payload));
    throw new DevinHttpError(`Devin chat failed (${response.status}): ${detail}`, response.status);
  }
  if (!response.body) {
    clearTimeout(idleTimer);
    throw new DevinHttpError("Devin chat returned an empty body.", 502);
  }

  const reader = response.body.getReader();
  let pending = new Uint8Array(0);

  try {
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (error) {
        if (controller.signal.aborted) {
          yield { type: "protocolError", message: `Devin stream went silent for ${Math.round(idleMs / 1000)}s.` };
          return;
        }
        throw error;
      }

      if (chunk.done) break;
      armIdle();

      if (chunk.value && chunk.value.length > 0) {
        const merged = new Uint8Array(pending.length + chunk.value.length);
        merged.set(pending, 0);
        merged.set(chunk.value, pending.length);
        pending = merged;
      }

      const { frames, consumedBytes } = consumeConnectFrames(pending, MAX_FRAME_PAYLOAD);
      if (consumedBytes > 0) pending = pending.subarray(consumedBytes);

      for (const frameEntry of frames) {
        const raw = frameEntry.compressed ? gunzipSync(frameEntry.payload) : frameEntry.payload;

        if (frameEntry.endStream) {
          const trailer = new TextDecoder().decode(raw).trim();
          if (!trailer) continue;
          try {
            const parsed = JSON.parse(trailer) as { error?: { code?: string; message?: string } };
            if (parsed.error?.code) {
              yield {
                type: "endStreamError",
                code: parsed.error.code,
                message: redactSecretString(parsed.error.message ?? ""),
              };
              return;
            }
          } catch {
            /* a non-JSON trailer is not an error */
          }
          continue;
        }

        const message = decodeGetChatMessageResponse(raw);

        if (message.deltaText || message.deltaThinking || message.deltaSignature || message.deltaSignatureType) {
          yield {
            type: "delta",
            text: message.deltaText,
            thinking: message.deltaThinking,
            thinkingSignature: message.deltaSignature,
            signatureType: message.deltaSignatureType ?? "",
          };
        }
        if (message.deltaToolCalls.length > 0) {
          yield {
            type: "toolcalls",
            calls: message.deltaToolCalls.map(call => ({
              id: call.id,
              name: call.name,
              argumentsJson: call.argumentsJson,
              ...(call.invalidJsonErr ? { invalidJsonErr: call.invalidJsonErr } : {}),
            })),
          };
        }
        if (message.usage) {
          yield {
            type: "usage",
            inputTokens: message.usage.inputTokens,
            outputTokens: message.usage.outputTokens,
            cacheReadTokens: message.usage.cacheReadTokens,
            cacheWriteTokens: message.usage.cacheWriteTokens,
            ...(message.usage.modelUid ? { modelUid: message.usage.modelUid } : {}),
          };
        }
        if (message.stopReason !== 0) {
          yield { type: "stop", stopReason: message.stopReason };
        }
      }
    }
  } finally {
    clearTimeout(idleTimer);
    try {
      await reader.cancel();
    } catch {
      /* the stream may already be closed */
    }
  }

  yield { type: "done" };
}

// ─── Model roster ───────────────────────────────────────────────────────────

/**
 * Fetch the entitlement-aware model roster.
 *
 * Returns whatever the account is allowed to call, which is the authoritative list — the static
 * seed in the registry is only the degraded fallback.
 */
export async function fetchDevinHttpModels(
  apiKey: string,
  deps: DevinHttpDeps = {},
  baseUrl: string = DEVIN_CASCADE_BASE_URL,
  abortSignal?: AbortSignal,
): Promise<CliModelConfig[]> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(AUTH_TIMEOUT_MS);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;

  const response = await doFetch(`${baseUrl.replace(/\/+$/, "")}${CLI_MODEL_CONFIGS_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      accept: "*/*",
    },
    body: binaryBody(encodeGetUserJwtRequest(buildDevinMetadata(apiKey))),
    signal,
  });

  const payload = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new DevinHttpError(
      `Devin model discovery failed (${response.status}): ${decodeErrorMessage(payload)}`,
      response.status,
    );
  }

  try {
    return decodeCliModelConfigs(payload);
  } catch {
    return decodeCliModelConfigs(gunzipSync(payload));
  }
}

export { DEFAULT_STOP_PATTERNS };
