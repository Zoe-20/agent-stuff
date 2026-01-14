import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";

type ContentBlock = {
	type?: string;
	text?: string;
	arguments?: Record<string, unknown>;
};

const FILE_TAG_REGEX = /<file\s+name=["']([^"']+)["']>/g;
const FILE_URL_REGEX = /file:\/\/[^\s"'<>]+/g;
const PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;

const extractFileReferencesFromText = (text: string): string[] => {
	const refs: string[] = [];

	for (const match of text.matchAll(FILE_TAG_REGEX)) {
		refs.push(match[1]);
	}

	for (const match of text.matchAll(FILE_URL_REGEX)) {
		refs.push(match[0]);
	}

	for (const match of text.matchAll(PATH_REGEX)) {
		refs.push(match[1]);
	}

	return refs;
};

const extractPathsFromToolArgs = (args: unknown): string[] => {
	if (!args || typeof args !== "object") {
		return [];
	}

	const refs: string[] = [];
	const record = args as Record<string, unknown>;
	const directKeys = ["path", "file", "filePath", "filepath", "fileName", "filename"] as const;
	const listKeys = ["paths", "files", "filePaths"] as const;

	for (const key of directKeys) {
		const value = record[key];
		if (typeof value === "string") {
			refs.push(value);
		}
	}

	for (const key of listKeys) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") {
					refs.push(item);
				}
			}
		}
	}

	return refs;
};

const extractFileReferencesFromContent = (content: unknown): string[] => {
	if (typeof content === "string") {
		return extractFileReferencesFromText(content);
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const refs: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;

		if (block.type === "text" && typeof block.text === "string") {
			refs.push(...extractFileReferencesFromText(block.text));
		}

		if (block.type === "toolCall") {
			refs.push(...extractPathsFromToolArgs(block.arguments));
		}
	}

	return refs;
};

const extractFileReferencesFromEntry = (entry: SessionEntry): string[] => {
	if (entry.type === "message") {
		return extractFileReferencesFromContent(entry.message.content);
	}

	if (entry.type === "custom_message") {
		return extractFileReferencesFromContent(entry.content);
	}

	return [];
};

const sanitizeReference = (raw: string): string => {
	let value = raw.trim();
	value = value.replace(/^["'`(<\[]+/, "");
	value = value.replace(/[>"'`,;).\]]+$/, "");
	value = value.replace(/[.,;:]+$/, "");
	return value;
};

const normalizeReferencePath = (raw: string, cwd: string): string | null => {
	let candidate = sanitizeReference(raw);
	if (!candidate) {
		return null;
	}

	if (candidate.startsWith("file://")) {
		try {
			candidate = fileURLToPath(candidate);
		} catch {
			return null;
		}
	}

	if (candidate.startsWith("~")) {
		candidate = path.join(os.homedir(), candidate.slice(1));
	}

	if (!path.isAbsolute(candidate)) {
		candidate = path.resolve(cwd, candidate);
	}

	return candidate;
};

const findLatestFileReference = (entries: SessionEntry[], cwd: string): string | null => {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const refs = extractFileReferencesFromEntry(entries[i]);
		for (let j = refs.length - 1; j >= 0; j -= 1) {
			const normalized = normalizeReferencePath(refs[j], cwd);
			if (normalized) {
				return normalized;
			}
		}
	}

	return null;
};

export default function (pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+f", {
		description: "Reveal the latest file reference in Finder",
		handler: async (ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const latest = findLatestFileReference(entries, ctx.cwd);

			if (!latest) {
				if (ctx.hasUI) {
					ctx.ui.notify("No file reference found in the session", "warning");
				}
				return;
			}

			if (!existsSync(latest)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`File not found: ${latest}`, "error");
				}
				return;
			}

			const stats = statSync(latest);
			const isDirectory = stats.isDirectory();

			let command = "open";
			let args: string[] = [];

			if (process.platform === "darwin") {
				args = isDirectory ? [latest] : ["-R", latest];
			} else {
				command = "xdg-open";
				args = [isDirectory ? latest : path.dirname(latest)];
			}

			const result = await pi.exec(command, args);
			if (result.code !== 0 && ctx.hasUI) {
				const errorMessage = result.stderr?.trim() || `Failed to reveal ${latest}`;
				ctx.ui.notify(errorMessage, "error");
			}
		},
	});

	pi.registerShortcut("ctrl+shift+f", {
		description: "Quick Look the latest file reference",
		handler: async (ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const latest = findLatestFileReference(entries, ctx.cwd);

			if (!latest) {
				if (ctx.hasUI) {
					ctx.ui.notify("No file reference found in the session", "warning");
				}
				return;
			}

			if (!existsSync(latest)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`File not found: ${latest}`, "error");
				}
				return;
			}

			const stats = statSync(latest);
			if (stats.isDirectory()) {
				if (ctx.hasUI) {
					ctx.ui.notify("Quick Look only works on files", "warning");
				}
				return;
			}

			if (process.platform !== "darwin") {
				if (ctx.hasUI) {
					ctx.ui.notify("Quick Look is only available on macOS", "warning");
				}
				return;
			}

			const result = await pi.exec("qlmanage", ["-p", latest]);
			if (result.code !== 0 && ctx.hasUI) {
				const errorMessage = result.stderr?.trim() || `Failed to Quick Look ${latest}`;
				ctx.ui.notify(errorMessage, "error");
			}
		},
	});
}
