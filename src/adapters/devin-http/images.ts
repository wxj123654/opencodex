import type { OcxContentPart, OcxMessage } from "../../types";
import {
  normalizeImageTargets,
  type NormalizeOptions,
  type NormalizeTarget,
} from "../anthropic-image-normalize";

/**
 * Devin/Cascade image preparation (mirrors the vendor CLI's `affogato/src/image.rs`
 * pipeline: decode → resize → re-encode → byte-limit check → base64 into the
 * protobuf `ImageData` field).
 *
 * The upstream nginx fronting `server.codeium.com` rejects request bodies above
 * ~14 MB with a bare `413 Request Entity Too Large` (probe-verified 2026-09-14:
 * 10 MB PNG ≈ 13.4 MB base64 passes, 11 MB PNG ≈ 14.7 MB fails). Because every
 * turn replays the WHOLE conversation — images included — one large screenshot
 * permanently poisons a session: each subsequent request re-sends it and 413s
 * again, which is exactly what the vendor CLI's resize/re-encode step prevents.
 *
 * This module reuses the wire-neutral ladder in `anthropic-image-normalize.ts`
 * (tiered maxEdge/quality steps, byte-weighted LRU cache, decode-bomb guards,
 * aggregate demotion). Differences from the Anthropic caller:
 *
 * - **Input is `OcxMessage[]`, not wire blocks.** Parts are cloned on write so the
 *   caller's parsed history is never mutated — the same `parsed.context.messages`
 *   array can be re-sent on retry and must stay byte-identical.
 * - **`overflowAction: "drop"`.** There is no downstream guard for Devin (the
 *   Anthropic guard's Rule 4 backstop does not exist here), so terminal overflow
 *   drops the OLDEST images until the budget fits.
 * - **Budget is smaller.** Anthropic's 20 MB assumes its own documented limit;
 *   Devin's measured ceiling is ~14 MB for the ENTIRE protobuf body, and text
 *   history shares it. 8 MiB of base64 leaves ~5 MB of headroom for a long
 *   session's text before nginx cuts the connection.
 */

/** Total base64 budget across all images in one request (see module header). */
export const DEVIN_IMAGE_BASE64_BUDGET = 8 * 1024 * 1024;

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/s;

interface ImageRef {
  messageIndex: number;
  partIndex: number;
  base64: string;
  mediaType: string;
}

function collectImageRefs(messages: OcxMessage[]): ImageRef[] {
  const refs: ImageRef[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    // Same role gate as messageImages() in turn.ts: only user/toolResult parts
    // ever reach the wire, so normalizing anything else would be wasted work.
    if (message.role !== "user" && message.role !== "toolResult") continue;
    if (typeof message.content === "string") continue;
    for (let p = 0; p < message.content.length; p++) {
      const part = message.content[p]!;
      if (part.type !== "image") continue;
      const match = part.imageUrl.match(DATA_URL_RE);
      if (!match) continue; // remote URL: dropped at projection time, nothing to shrink
      refs.push({ messageIndex: i, partIndex: p, base64: match[2]!, mediaType: match[1]! });
    }
  }
  return refs;
}

/**
 * Return a copy of `messages` with every inline image normalized to fit the
 * upstream body limit. Messages without images are returned by reference; only
 * messages whose parts actually changed are cloned.
 *
 * `drop(note)` replaces the image part with a text part carrying the note —
 * matching the CLI's "dropping" behavior while keeping the turn's text visible
 * to the model. A message left with zero parts gets the note as its only part.
 */
export async function prepareDevinImages(
  messages: OcxMessage[],
  options: NormalizeOptions & { budget?: number } = {},
): Promise<OcxMessage[]> {
  const refs = collectImageRefs(messages);
  if (refs.length === 0) return messages;

  // Lazily cloned content arrays, one per touched message.
  const clones = new Map<number, OcxContentPart[]>();
  const contentFor = (messageIndex: number): OcxContentPart[] => {
    let parts = clones.get(messageIndex);
    if (!parts) {
      parts = [...(messages[messageIndex]!.content as OcxContentPart[])];
      clones.set(messageIndex, parts);
    }
    return parts;
  };

  const targets: NormalizeTarget[] = refs.map(ref => ({
    base64: ref.base64,
    mediaType: ref.mediaType,
    replace: (data, mediaType) => {
      contentFor(ref.messageIndex)[ref.partIndex] = {
        type: "image",
        imageUrl: `data:${mediaType};base64,${data}`,
      };
    },
    drop: note => {
      contentFor(ref.messageIndex)[ref.partIndex] = { type: "text", text: note };
    },
  }));

  await normalizeImageTargets(targets, {
    ...options,
    budget: options.budget ?? DEVIN_IMAGE_BASE64_BUDGET,
    overflowAction: "drop",
  });

  if (clones.size === 0) return messages;
  return messages.map((message, i) => {
    const parts = clones.get(i);
    if (!parts) return message;
    // A message whose only content was a dropped image must not go out empty —
    // an empty prompt string is legal on the wire but reads as a gap to the model.
    const finalParts = parts.length > 0 ? parts : [{ type: "text" as const, text: "[image omitted]" }];
    // Only user/toolResult messages reach this branch (collectImageRefs gate), and
    // both declare content as OcxContentPart[] — the union spread just can't see it.
    return { ...message, content: finalParts } as OcxMessage;
  });
}
