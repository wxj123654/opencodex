/**
 * Cursor's Connect framing entry point — now a re-export of the shared module.
 *
 * The Connect protocol is not Cursor-specific: it is connectrpc's HTTP framing (1-byte flags +
 * big-endian uint32 length, 0x01 = gzip, 0x02 = end-stream trailer), and the Devin/Cascade
 * `devin-http` adapter speaks the same wire. The implementation moved to
 * `src/adapters/connect-framing.ts` so a second consumer does not have to reach into the Cursor
 * subtree; this shim keeps every existing Cursor import and test path intact.
 */
export * from "../connect-framing";
