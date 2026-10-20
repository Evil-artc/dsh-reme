/**
 * The model-facing tools this plugin contributes to `ctx.tools`.
 *
 * Recalled content is untrusted data, never instructions 鈥?that framing is
 * stated in the `reme_search` description so a poisoned memory file cannot
 * steer the agent.
 *
 * @module dsh-reme/tools
 */
import type { ReMeClient } from './client.js';
import type { ResolvedConfig } from './config.js';
import { type ToolDefinition } from './harness.js';
/**
 * Clip `value` to `limit` characters on a line-ish boundary, reporting whether
 * anything was dropped.
 */
export declare function clip(value: string, limit: number): {
    text: string;
    truncated: boolean;
};
/**
 * Turn a free-text title into a filename-safe slug.
 * @param value - the title to slugify.
 * @returns a lowercase hyphenated slug, or `note` when nothing survives.
 */
export declare function slugify(value: string): string;
/** `YYYYMMDD` in local time, the date stamp ReMe uses in its own filenames. */
export declare function dateStamp(now?: Date): string;
/**
 * Resolve the request's path/name into the workspace path ReMe should write.
 * A path carrying a directory is honoured as given; a bare filename is filed
 * under the digest directory; otherwise the name and date build the filename.
 */
export declare function resolveWritePath(rawPath: string | undefined, rawName: string | undefined, digestDir: string, now?: Date): {
    path: string;
    name: string;
};
/**
 * Split `content` into parts of at most `budget` characters, preferring line
 * boundaries so a stored note stays readable.
 */
export declare function splitContent(content: string, budget: number): string[];
/**
 * Assemble the tool definitions for one configured ReMe deployment.
 * @param client - the ReMe transport.
 * @param config - resolved plugin configuration.
 */
export declare function createTools(client: ReMeClient, config: ResolvedConfig): ToolDefinition[];
