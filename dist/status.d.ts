/**
 * The read-only diagnostic tool for the automatic memory layer.
 *
 * It lives in its own module because it is the one place that knows about both
 * halves — recall and extraction — while neither half needs to know about the
 * other. Keeping it here also keeps `index.ts` a wiring file rather than a
 * rendering one.
 *
 * @module dsh-reme/status
 */
import type { RecallStatusSnapshot } from './auto.js';
import type { ResolvedConfig } from './config.js';
import type { ExtractStatusSnapshot } from './extract.js';
import { type ToolDefinition } from './harness.js';
/** What the tool reports; either half may be absent when it is switched off. */
export interface MemoryStatusSnapshot {
    recall?: RecallStatusSnapshot;
    extract?: ExtractStatusSnapshot;
}
/**
 * Build the diagnostic tool.
 * @param config - resolved plugin configuration.
 * @param snapshot - reads both halves at call time.
 */
export declare function createMemoryStatusTool(config: ResolvedConfig, snapshot: () => MemoryStatusSnapshot): ToolDefinition;
