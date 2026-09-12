/**
 * Minimal protobuf codec for the Devin/Cascade Connect API.
 *
 * ## Why a hand-rolled codec
 *
 * The Cascade wire is connectrpc over HTTP with protobuf bodies. opencodex already depends on
 * `@bufbuild/protobuf`, but that path needs generated message descriptors, and there are none for
 * Codeium's private schema — the field numbers below are reverse-engineered facts read off the
 * live wire, not a published `.proto`. Hand-writing the ~20 message shapes we actually send keeps
 * the reverse-engineered contract in one reviewable file instead of spreading it across generated
 * code nobody can regenerate.
 *
 * Proto3 semantics apply throughout: zero-valued scalars are omitted on the wire, so a field whose
 * value equals its default is indistinguishable from an unset field. That is not a detail —
 * `CompletionConfiguration.temperature` hits it directly (see `turn.ts`: a literal 0 is dropped and
 * the upstream rejects the resulting "unset temperature" with `invalid_argument`).
 *
 * ## Provenance
 *
 * Field numbers, enum values, and message shapes were verified against the live Cascade API on
 * 2026-09-12 (devin 3000.10.21, Free plan). The encoder/decoder scaffolding closely follows
 * `github.com/CaiJingLong/devin-gateway` (`src/proto.ts`, MIT, Copyright (c) 2026 CaiJingLong),
 * which reached the same shapes independently; the module layout, the response decoders, and the
 * `GetCliModelConfigs` roster parser are ours. See CREDITS.md.
 *
 * Everything here is pure: no I/O, no globals, no config. `client.ts` owns the transport.
 */

// ─── Encoder ────────────────────────────────────────────────────────────────

export class ProtoEncoder {
  private buf: number[] = [];

  private varint(n: number): void {
    n = n >>> 0;
    while (n > 0x7f) {
      this.buf.push((n & 0x7f) | 0x80);
      n = n >>> 7;
    }
    this.buf.push(n);
  }

  private varintBig(n: bigint): void {
    n = n & 0xffffffffffffffffn;
    while (n > 0x7fn) {
      this.buf.push(Number(n & 0x7fn) | 0x80);
      n = n >> 7n;
    }
    this.buf.push(Number(n));
  }

  private tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  string(field: number, value: string | undefined | null): void {
    // proto3: an empty string IS the default, so it is omitted rather than length-prefixed.
    if (!value) return;
    const bytes = new TextEncoder().encode(value);
    this.tag(field, 2);
    this.varint(bytes.length);
    for (const b of bytes) this.buf.push(b);
  }

  uint32(field: number, value: number | undefined): void {
    if (value === undefined || value === 0) return;
    this.tag(field, 0);
    this.varint(value);
  }

  uint64(field: number, value: bigint | number | undefined): void {
    if (value === undefined || value === 0n || value === 0) return;
    this.tag(field, 0);
    this.varintBig(typeof value === "bigint" ? value : BigInt(value));
  }

  bool(field: number, value: boolean | undefined): void {
    if (!value) return;
    this.tag(field, 0);
    this.varint(1);
  }

  double(field: number, value: number | undefined): void {
    if (value === undefined || value === 0) return;
    this.tag(field, 1);
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    for (const b of new Uint8Array(buf)) this.buf.push(b);
  }

  message(field: number, encode: (e: ProtoEncoder) => void): void {
    const sub = new ProtoEncoder();
    encode(sub);
    const subBytes = sub.finish();
    this.tag(field, 2);
    this.varint(subBytes.length);
    for (const b of subBytes) this.buf.push(b);
  }

  repeatedMessage<T>(field: number, values: T[] | undefined, encode: (e: ProtoEncoder, v: T) => void): void {
    if (!values || values.length === 0) return;
    // Non-packed encoding: message fields are always length-delimited, one tag per element.
    for (const v of values) this.message(field, e => encode(e, v));
  }

  repeatedString(field: number, values: string[] | undefined): void {
    if (!values || values.length === 0) return;
    for (const v of values) this.string(field, v);
  }

  finish(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

// ─── Decoder ────────────────────────────────────────────────────────────────

export class ProtoDecoder {
  private bytes: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }

  readTag(): { field: number; wire: number } {
    const tag = Number(this.readVarint());
    return { field: tag >>> 3, wire: tag & 0x07 };
  }

  readString(): string {
    const len = Number(this.readVarint());
    const start = this.pos;
    this.pos += len;
    return new TextDecoder().decode(this.bytes.subarray(start, start + len));
  }

  readBytes(): Uint8Array {
    const len = Number(this.readVarint());
    const start = this.pos;
    this.pos += len;
    return this.bytes.subarray(start, start + len);
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.readVarint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2: {
        // Read the length FIRST, then advance. `this.pos += this.readVarint()` looks equivalent
        // but is not: the compound assignment captures `this.pos` before evaluating the right-hand
        // side, so the varint advance that `readVarint` performs on `this.pos` is overwritten and
        // the cursor lands short by the varint's own width. For a 1-byte length that is one byte
        // past the field, which desynchronizes every subsequent tag in the same message.
        //
        // This was inherited from the vendored reference implementation; the regression test is
        // `tests/providers/devin-http-proto.test.ts` ("skips a length-delimited unknown field
        // exactly"), and the failure is otherwise invisible on a payload whose unknown fields all
        // precede the fields the caller reads.
        const length = Number(this.readVarint());
        this.pos += length;
        break;
      }
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`Unknown protobuf wire type: ${wire}`);
    }
  }

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  readMessage<T>(fn: (d: ProtoDecoder) => T): T {
    return fn(new ProtoDecoder(this.readBytes()));
  }
}

// ─── Enums (proto3 numeric values) ──────────────────────────────────────────

/** `ChatMessagePrompt.source`. */
export const ChatMessageSource = {
  UNSPECIFIED: 0,
  USER: 1,
  /** Assistant turns are replayed as SYSTEM — the API has no ASSISTANT source. */
  SYSTEM: 2,
  UNKNOWN: 3,
  TOOL: 4,
  SYSTEM_PROMPT: 5,
} as const;

/** `GetChatMessageResponse.stop_reason`. 10 is the tool-call terminal. */
export const StopReason = {
  UNSPECIFIED: 0,
  MAX_TOKENS: 3,
  FUNCTION_CALL: 10,
} as const;

/** `GetChatMessageRequest.request_type`. CASCADE is the conversational mode. */
export const ChatMessageRequestType = {
  CASCADE: 5,
} as const;

export const ConversationalPlannerMode = {
  DEFAULT: 1,
} as const;

/** `PromptCacheOptions.type`. EPHEMERAL asks the server to reuse the conversation prefix. */
export const CacheControlType = {
  EPHEMERAL: 1,
} as const;

// ─── Metadata: the shared credential envelope ───────────────────────────────

/**
 * The `Metadata` message every Cascade RPC carries.
 *
 * The IDE identity fields are NOT cosmetic: the server uses them to decide which client contract
 * to apply. We present as Windsurf, because Cascade is the Windsurf/Devin shared backend and that
 * is the only published client shape for this RPC set.
 */
export interface Metadata {
  ideName: string;
  ideVersion: string;
  extensionName: string;
  extensionVersion: string;
  apiKey: string;
  locale: string;
  userJwt?: string;
}

export function encodeMetadata(e: ProtoEncoder, m: Metadata): void {
  e.string(1, m.ideName);
  // Field order is deliberately not numeric: it mirrors the observed client and keeps the diff
  // against the wire capture readable. Protobuf does not require ascending tags.
  e.string(7, m.ideVersion);
  e.string(12, m.extensionName);
  e.string(2, m.extensionVersion);
  e.string(3, m.apiKey);
  e.string(4, m.locale);
  e.string(21, m.userJwt);
}

// ─── GetUserJwt: session token → per-user JWT ───────────────────────────────

export function encodeGetUserJwtRequest(m: Metadata): Uint8Array {
  const enc = new ProtoEncoder();
  enc.message(1, e => encodeMetadata(e, m));
  return enc.finish();
}

export interface GetUserJwtResponse {
  userJwt: string;
  /** Present when the account is pinned to a regional/private API host. */
  customApiServerUrl: string;
}

export function decodeGetUserJwtResponse(data: Uint8Array): GetUserJwtResponse {
  const d = new ProtoDecoder(data);
  const res: GetUserJwtResponse = { userJwt: "", customApiServerUrl: "" };
  while (!d.done) {
    const { field, wire } = d.readTag();
    if (field === 1 && wire === 2) res.userJwt = d.readString();
    else if (field === 2 && wire === 2) res.customApiServerUrl = d.readString();
    else d.skip(wire);
  }
  return res;
}

// ─── Tool calls ─────────────────────────────────────────────────────────────

/**
 * A tool call as it appears on the wire.
 *
 * `argumentsJson` is a JSON *string*, not a message: the API carries the argument payload
 * pre-serialized. `invalidJson*` are populated by the server when its own parse of the model's
 * output failed — a case worth surfacing rather than silently coercing to `{}`.
 */
export interface ChatToolCall {
  id: string;
  name: string;
  argumentsJson: string;
  invalidJsonStr?: string;
  invalidJsonErr?: string;
  isCustomToolCall?: boolean;
}

function encodeChatToolCall(e: ProtoEncoder, tc: ChatToolCall): void {
  e.string(1, tc.id);
  e.string(2, tc.name);
  e.string(3, tc.argumentsJson);
  e.string(4, tc.invalidJsonStr);
  e.string(5, tc.invalidJsonErr);
  e.bool(6, tc.isCustomToolCall);
}

export function decodeChatToolCall(d: ProtoDecoder): ChatToolCall {
  const tc: ChatToolCall = { id: "", name: "", argumentsJson: "" };
  while (!d.done) {
    const { field, wire } = d.readTag();
    switch (field) {
      case 1:
        tc.id = d.readString();
        break;
      case 2:
        tc.name = d.readString();
        break;
      case 3:
        tc.argumentsJson = d.readString();
        break;
      case 4:
        tc.invalidJsonStr = d.readString();
        break;
      case 5:
        tc.invalidJsonErr = d.readString();
        break;
      case 6:
        tc.isCustomToolCall = d.readVarint() !== 0n;
        break;
      default:
        d.skip(wire);
    }
  }
  return tc;
}

// ─── Images ─────────────────────────────────────────────────────────────────

export interface ImageData {
  base64Data: string;
  mimeType: string;
}

function encodeImageData(e: ProtoEncoder, img: ImageData): void {
  e.string(1, img.base64Data);
  e.string(2, img.mimeType);
}

// ─── ChatMessagePrompt: one turn of replayed history ────────────────────────

export interface ChatMessagePrompt {
  messageId: string;
  source: number;
  prompt: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  toolResultIsError?: boolean;
  images?: ImageData[];
  thinking?: string;
  signature?: string;
  signatureType?: string;
}

export function encodeChatMessagePrompt(e: ProtoEncoder, p: ChatMessagePrompt): void {
  e.string(1, p.messageId);
  e.uint32(2, p.source);
  e.string(3, p.prompt);
  e.repeatedMessage(6, p.toolCalls, encodeChatToolCall);
  e.string(7, p.toolCallId);
  e.bool(9, p.toolResultIsError);
  e.repeatedMessage(10, p.images, encodeImageData);
  e.string(11, p.thinking);
  e.string(12, p.signature);
  e.string(18, p.signatureType);
}

// ─── Tool definitions and choice ────────────────────────────────────────────

export interface ChatToolDefinition {
  name: string;
  description: string;
  /** The JSON Schema, pre-serialized into a string field. */
  jsonSchemaString: string;
  strict: boolean;
}

function encodeChatToolDefinition(e: ProtoEncoder, t: ChatToolDefinition): void {
  e.string(1, t.name);
  e.string(2, t.description);
  e.string(3, t.jsonSchemaString);
  e.bool(12, t.strict);
}

/**
 * `ChatToolChoice`. `optionName` is the mode word (`auto`, `required`, `none`) and `toolName`
 * pins a specific function; they are independent fields, not a oneof.
 */
export interface ChatToolChoice {
  optionName?: string;
  toolName?: string;
}

function encodeChatToolChoice(e: ProtoEncoder, c: ChatToolChoice): void {
  e.string(1, c.optionName);
  e.string(2, c.toolName);
}

// ─── Completion configuration ───────────────────────────────────────────────

/**
 * Sampling and stop controls.
 *
 * `maxNewlines` is a Cascade-specific guard that bounds line count independently of token count;
 * `fimEotProbThreshold` belongs to the fill-in-the-middle path and is included only because the
 * observed client always sends it.
 */
export interface CompletionConfiguration {
  numCompletions: bigint;
  maxTokens: bigint;
  maxNewlines: bigint;
  temperature: number;
  firstTemperature: number;
  topK: bigint;
  topP: number;
  stopPatterns: string[];
  fimEotProbThreshold: number;
}

function encodeCompletionConfiguration(e: ProtoEncoder, c: CompletionConfiguration): void {
  e.uint64(1, c.numCompletions);
  e.uint64(2, c.maxTokens);
  e.uint64(3, c.maxNewlines);
  e.double(5, c.temperature);
  e.double(6, c.firstTemperature);
  e.uint64(7, c.topK);
  e.double(8, c.topP);
  e.repeatedString(9, c.stopPatterns);
  e.double(11, c.fimEotProbThreshold);
}

function encodePromptCacheOptions(e: ProtoEncoder, type: number): void {
  e.uint32(1, type);
}

// ─── GetChatMessage: the streaming chat RPC ─────────────────────────────────

export interface GetChatMessageRequest {
  metadata: Metadata;
  /** The system prompt. Separate from `chatMessagePrompts`. */
  prompt: string;
  chatMessagePrompts: ChatMessagePrompt[];
  /** The Cascade model UID, verbatim — effort is part of the UID, not a separate field. */
  chatModelUid: string;
  configuration: CompletionConfiguration;
  tools: ChatToolDefinition[];
  disableParallelToolCalls: boolean;
  toolChoice: ChatToolChoice;
  /**
   * Conversation identity. Reusing one across turns gives the server the continuity it needs to
   * keep the prompt cache warm; a fresh UUID makes the turn stateless.
   */
  cascadeId: string;
  executionId: string;
}

export function encodeGetChatMessageRequest(r: GetChatMessageRequest): Uint8Array {
  const enc = new ProtoEncoder();
  enc.message(1, e => encodeMetadata(e, r.metadata));
  enc.string(2, r.prompt);
  enc.repeatedMessage(3, r.chatMessagePrompts, encodeChatMessagePrompt);
  enc.string(21, r.chatModelUid);
  enc.uint32(7, ChatMessageRequestType.CASCADE);
  enc.message(8, e => encodeCompletionConfiguration(e, r.configuration));
  enc.repeatedMessage(10, r.tools, encodeChatToolDefinition);
  enc.bool(11, r.disableParallelToolCalls);
  enc.message(12, e => encodeChatToolChoice(e, r.toolChoice));
  // Always on: every turn asks the server to cache its prefix. There is no downside when the
  // prefix is not reusable, and it is the difference between a cached and uncached replay.
  enc.message(13, e => encodePromptCacheOptions(e, CacheControlType.EPHEMERAL));
  enc.string(16, r.cascadeId);
  enc.uint32(20, ConversationalPlannerMode.DEFAULT);
  enc.string(22, r.executionId);
  return enc.finish();
}

// ─── GetChatMessage response ────────────────────────────────────────────────

export interface ModelUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messageId?: string;
  /** The model UID the server actually billed, which may differ from the requested one. */
  modelUid?: string;
}

export interface GetChatMessageResponse {
  messageId: string;
  deltaText: string;
  stopReason: number;
  /** Tool calls in this frame. Observed COMPLETE, not incremental (see `turn.ts`). */
  deltaToolCalls: ChatToolCall[];
  usage: ModelUsageStats | null;
  deltaThinking: string;
  deltaSignature: string;
  redact?: boolean;
  thinkingRedacted?: boolean;
  deltaSignatureType?: string;
  outputId?: string;
  requestId?: string;
  actualModelUid?: string;
  creditCost?: number;
}

export function decodeGetChatMessageResponse(data: Uint8Array): GetChatMessageResponse {
  const d = new ProtoDecoder(data);
  const res: GetChatMessageResponse = {
    messageId: "",
    deltaText: "",
    stopReason: 0,
    deltaToolCalls: [],
    usage: null,
    deltaThinking: "",
    deltaSignature: "",
  };
  while (!d.done) {
    const { field, wire } = d.readTag();
    switch (field) {
      case 1:
        res.messageId = d.readString();
        break;
      case 3:
        res.deltaText = d.readString();
        break;
      case 5:
        res.stopReason = Number(d.readVarint());
        break;
      case 6:
        res.deltaToolCalls.push(d.readMessage(decodeChatToolCall));
        break;
      case 7:
        res.usage = d.readMessage(decodeModelUsageStats);
        break;
      case 8:
        res.redact = d.readVarint() !== 0n;
        break;
      case 9:
        res.deltaThinking = d.readString();
        break;
      case 10:
        res.deltaSignature = d.readString();
        break;
      case 11:
        res.thinkingRedacted = d.readVarint() !== 0n;
        break;
      case 14:
        res.creditCost = Number(d.readVarint());
        break;
      case 15:
        res.outputId = d.readString();
        break;
      case 17:
        res.requestId = d.readString();
        break;
      case 21:
        res.deltaSignatureType = d.readString();
        break;
      case 23:
        res.actualModelUid = d.readString();
        break;
      default:
        d.skip(wire);
    }
  }
  return res;
}

function decodeModelUsageStats(d: ProtoDecoder): ModelUsageStats {
  const s: ModelUsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  while (!d.done) {
    const { field, wire } = d.readTag();
    switch (field) {
      case 2:
        s.inputTokens = Number(d.readVarint());
        break;
      case 3:
        s.outputTokens = Number(d.readVarint());
        break;
      case 4:
        s.cacheWriteTokens = Number(d.readVarint());
        break;
      case 5:
        s.cacheReadTokens = Number(d.readVarint());
        break;
      case 7:
        s.messageId = d.readString();
        break;
      case 9:
        s.modelUid = d.readString();
        break;
      default:
        d.skip(wire);
    }
  }
  return s;
}

// ─── GetCliModelConfigs: the entitlement-aware roster ───────────────────────

export interface CliModelConfig {
  id: string;
  label: string;
  contextWindow: number;
  supportsImages: boolean;
  supportsThinking: boolean;
}

/**
 * Decode `GetCliModelConfigsResponse` into the fields the catalog needs.
 *
 * Shape: repeated `ClientModelConfig` at field 1, each carrying the model uid at field 22, a human
 * label at field 1, an enabled flag at field 4, image support at field 5, the max-context figure at
 * field 18, and a nested `ModelInfo` at field 23 whose `ModelFeatures` (field 6) holds
 * `supports_thinking` (field 15).
 *
 * Disabled entries and entries with a blank uid are dropped here rather than downstream: a
 * disabled model is not callable, so publishing it would only produce a 4xx at request time.
 */
export function decodeCliModelConfigs(data: Uint8Array): CliModelConfig[] {
  const models: CliModelConfig[] = [];
  const d = new ProtoDecoder(data);
  while (!d.done) {
    const { field, wire } = d.readTag();
    if (field === 1 && wire === 2) {
      const parsed = d.readMessage(parseClientModelConfig);
      if (parsed) models.push(parsed);
    } else {
      d.skip(wire);
    }
  }
  return models;
}

function parseClientModelConfig(decoder: ProtoDecoder): CliModelConfig | null {
  let id = "";
  let label = "";
  let disabled = false;
  let supportsImages = false;
  let supportsThinking = false;
  let configuredMaxTokens = 0;

  while (!decoder.done) {
    const { field, wire } = decoder.readTag();
    if (field === 1 && wire === 2) label = decoder.readString();
    else if (field === 4 && wire === 0) disabled = decoder.readVarint() !== 0n;
    else if (field === 5 && wire === 0) supportsImages = decoder.readVarint() !== 0n;
    else if (field === 18 && wire === 0) configuredMaxTokens = Number(decoder.readVarint());
    else if (field === 22 && wire === 2) id = decoder.readString();
    else if (field === 23 && wire === 2) supportsThinking = decoder.readMessage(parseModelInfoThinking);
    else decoder.skip(wire);
  }

  const trimmedId = id.trim();
  if (disabled || !trimmedId) return null;

  return {
    id: trimmedId,
    label: label.trim() || trimmedId,
    contextWindow: configuredMaxTokens > 0 ? configuredMaxTokens : 0,
    supportsImages,
    supportsThinking,
  };
}

/** `ModelInfo` (field 23) → `model_features` (field 6) → `supports_thinking` (field 15). */
function parseModelInfoThinking(decoder: ProtoDecoder): boolean {
  while (!decoder.done) {
    const { field, wire } = decoder.readTag();
    if (field === 6 && wire === 2) return decoder.readMessage(parseModelFeaturesThinking);
    decoder.skip(wire);
  }
  return false;
}

function parseModelFeaturesThinking(decoder: ProtoDecoder): boolean {
  while (!decoder.done) {
    const { field, wire } = decoder.readTag();
    if (field === 15 && wire === 0) return decoder.readVarint() !== 0n;
    decoder.skip(wire);
  }
  return false;
}

