import createIgnore from "ignore";
import pluginBabel from "prettier/plugins/babel";
import pluginEstree from "prettier/plugins/estree";
import pluginHtml from "prettier/plugins/html";
import pluginMarkdown from "prettier/plugins/markdown";
import pluginPostcss from "prettier/plugins/postcss";
import pluginTypescript from "prettier/plugins/typescript";
import pluginYaml from "prettier/plugins/yaml";
import prettier from "prettier/standalone";

import { MagicString } from "./utils/string";
import { ImageUploader } from "./image-uploader";

import type PrettierPlugin from "./main";
import type { Settings } from "./model";
import type { Ignore } from "ignore";
import type { App, Editor, TFile } from "obsidian";
import type { Options } from "prettier";

const USE_PRETTIER_KEY = "prettier";
const USE_FAST_MODE_KEY = "prettier-fast-mode";

const REGEXP_UNORDERED_LIST_ITEMS_WITH_EXTRA_SPACES = /^[^\S\r\n]*[-*+][^\S\r\n]([^\S\r\n]+)/;
const REGEXP_EMPTY_LIST_ITEMS_WITHOUT_TRAILING_SPACES =
  /^((?:[^\S\r\n]*[-*+](?:[^\S\r\n]+\[.{1}\])?)|(?:[^\S\r\n]*\d+\.))$/;

export class Formatter {
  private app: App;
  private settings: Settings;
  private ignoreCache: Map<string, Ignore> = new Map();
  private imageUploader: ImageUploader;

  constructor(plugin: PrettierPlugin) {
    this.app = plugin.app;
    this.settings = plugin.settings;
    this.imageUploader = new ImageUploader(plugin);
  }

  async formatOnSave(editor: Editor, file: TFile | null) {
    if (!file || !this.settings.formatOnSave) return;

    await this.formatContent(editor, file);
  }

  async formatOnFileChange(file: TFile) {
    if (!this.settings.formatOnFileChange) return;

    await this.formatFile(file);
  }

  async formatFile(file: TFile) {
    if (!this.shouldUsePrettier(file)) return;

    const content = new MagicString(await this.app.vault.read(file));
    const options = this.getPrettierOptions(file);

    let offset = -1;
    offset = await this.imageUploader.uploadImages(content, file, offset);

    content.mutate(await prettier.format(content.current, options));

    if (this.settings.removeExtraSpaces) {
      offset = this.removeExtraSpaces(content, offset);
    }
    if (this.settings.addTrailingSpaces) {
      offset = this.addTrailingSpaces(content, offset);
    }
    if (this.settings.headerStartLevel > 1) {
      offset = this.adjustHeaderLevels(content, offset);
    }
    // Re-calculate minLevel after adjusting headers, because levels might have changed
    if (this.settings.autoNumbering) {
      offset = this.addHeaderNumbering(content, offset);
    }

    if (!content.isModified) return;

    await this.app.vault.modify(file, content.current);
  }

  async formatContent(editor: Editor, file: TFile | null) {
    if (!file || !this.shouldUsePrettier(file)) return;

    const { left, top } = editor.getScrollInfo();

    const content = new MagicString(editor.getValue());
    const options = this.getPrettierOptions(file);

    let offset = -1;
    if (!this.shouldUseFastMode(file)) {
      offset = content.positionToOffset(editor.getCursor());
    }

    offset = await this.imageUploader.uploadImages(content, file, offset);

    if (this.shouldUseFastMode(file)) {
      content.mutate(await prettier.format(content.current, options));
    } else {
      const result = await prettier.formatWithCursor(content.current, {
        cursorOffset: offset,
        ...options,
      });
      content.mutate(result.formatted);
      offset = result.cursorOffset;
    }

    if (this.settings.removeExtraSpaces) {
      offset = this.removeExtraSpaces(content, offset);
    }
    if (this.settings.addTrailingSpaces) {
      offset = this.addTrailingSpaces(content, offset);
    }
    if (this.settings.headerStartLevel > 1) {
      offset = this.adjustHeaderLevels(content, offset);
    }
    // Re-calculate minLevel after adjusting headers, because levels might have changed
    if (this.settings.autoNumbering) {
      offset = this.addHeaderNumbering(content, offset);
    }

    if (!content.isModified) return;

    editor.setValue(content.current);
    editor.scrollTo(left, top);

    if (offset !== -1) {
      editor.setCursor(content.offsetToPosition(offset));
    }
  }

  async formatSelection(editor: Editor, file: TFile | null) {
    if (!file || !this.shouldUsePrettier(file)) return;

    const content = new MagicString(editor.getSelection());
    const options = this.getPrettierOptions(file);

    await this.imageUploader.uploadImages(content, file);

    content.mutate(await prettier.format(content.current, options));

    const isOriginalHasNewLine = content.original.endsWith("\n");
    const isModifiedHasNewLine = content.current.endsWith("\n");
    if (isOriginalHasNewLine && !isModifiedHasNewLine) {
      content.append("\n");
    } else if (!isOriginalHasNewLine && isModifiedHasNewLine) {
      content.delete(-1);
    }
    if (this.settings.removeExtraSpaces) {
      this.removeExtraSpaces(content);
    }
    if (this.settings.addTrailingSpaces) {
      this.addTrailingSpaces(content);
    }

    if (!content.isModified) return;

    editor.replaceSelection(content.current);
  }

  removeExtraSpaces(content: MagicString, offset = -1) {
    const matches = content.match<1>(REGEXP_UNORDERED_LIST_ITEMS_WITH_EXTRA_SPACES);

    let index = offset;
    for (const [remove] of matches.toReversed()) {
      index = content.delete(remove.start, remove.end, index);
    }

    return index;
  }

  addTrailingSpaces(content: MagicString, offset = -1) {
    const matches = content.match<1>(REGEXP_EMPTY_LIST_ITEMS_WITHOUT_TRAILING_SPACES);

    let index = offset;
    for (const [preserve] of matches.toReversed()) {
      index = content.insert(preserve.end, " ", index);
    }

    return index;
  }

  adjustHeaderLevels(content: MagicString, offset = -1) {
    const lines = content.current.split("\n");
    let inCodeBlock = false;
    let currentOffset = 0;
    let index = offset;
    const edits: { start: number; end: number; text: string }[] = [];

    // Find the minimum header level in the document
    let minLevel = 100;
    let hasHeader = false;

    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
      }
      if (!inCodeBlock) {
        const match = line.match(/^(\s*)(#+)(\s+)/);
        if (match) {
          hasHeader = true;
          const hashes = match[2]!;
          if (hashes.length < minLevel) {
            minLevel = hashes.length;
          }
        }
      }
    }

    if (!hasHeader) return index;

    const targetStartLevel = this.settings.headerStartLevel;
    // Calculate how much we need to shift.
    // If minLevel is 5 (#####) and target is 2 (##), we shift by 2 - 5 = -3.
    // So ##### (5) becomes ## (2).
    const shift = targetStartLevel - minLevel;

    if (shift === 0) return index;

    inCodeBlock = false;
    currentOffset = 0;

    for (const line of lines) {
      const lineLength = line.length + 1;

      if (line.trim().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
      }

      if (!inCodeBlock) {
        const match = line.match(/^(\s*)(#+)(\s+)/);
        if (match) {
          const indent = match[1]!;
          const hashes = match[2]!;
          const currentLevel = hashes.length;
          const newLevel = currentLevel + shift;

          if (newLevel !== currentLevel && newLevel >= 1 && newLevel <= 6) {
            const start = currentOffset + indent.length;
            const end = start + hashes.length;
            edits.push({
              start,
              end,
              text: "#".repeat(newLevel),
            });
          }
        }
      }
      currentOffset += lineLength;
    }

    for (const edit of edits.reverse()) {
      index = content.update(edit.start, edit.end, edit.text, index);
    }

    return index;
  }

  addHeaderNumbering(content: MagicString, offset = -1) {
    const lines = content.current.split("\n");
    let inCodeBlock = false;
    let currentOffset = 0;
    let index = offset;
    let counters: number[] = [];
    const edits: { start: number; end: number; text: string }[] = [];

    // Find min level to correctly calculate relative level
    let minLevel = 100;
    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
      }
      if (!inCodeBlock) {
        const match = line.match(/^(\s*)(#+)(\s+)/);
        if (match) {
          const hashes = match[2]!;
          if (hashes.length < minLevel) {
            minLevel = hashes.length;
          }
        }
      }
    }

    if (minLevel === 100) return index;

    inCodeBlock = false;
    currentOffset = 0;

    for (const line of lines) {
      const lineLength = line.length + 1;

      if (line.trim().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
      }

      if (!inCodeBlock) {
        const match = line.match(/^(\s*)(#+)(\s+)(.*)$/);
        if (match) {
          const indent = match[1]!;
          const hashes = match[2]!;
          const space = match[3]!;
          const text = match[4]!;

          // Calculate relative level: minLevel -> 1, minLevel+1 -> 2, etc.
          const level = hashes.length - minLevel + 1;

          // If header levels are adjusted, we need to use the adjusted level
          // But wait, addHeaderNumbering runs AFTER adjustHeaderLevels?
          // In formatFile/formatContent:
          // 1. removeExtraSpaces
          // 2. addTrailingSpaces
          // 3. adjustHeaderLevels
          // 4. addHeaderNumbering
          //
          // So if adjustHeaderLevels ran, the `hashes.length` here is already the adjusted level.
          // And `minLevel` calculated at start of this function is also based on adjusted levels.
          // So if targetStartLevel is 2, the document starts with ## (level 2).
          // minLevel = 2.
          // First header ##: level = 2 - 2 + 1 = 1.
          // Correct.

          if (level > counters.length) {
            while (counters.length < level) counters.push(1);
          } else {
            counters = counters.slice(0, level);
            counters[level - 1]!++;
          }

          const numbering = counters.join(".");
          let prefix = `${numbering}`; // Default: no trailing dot for 1.1, 1.1.1

          // Only top level (relative level 1) gets a trailing dot: "1.", "2."
          if (level === 1) {
            prefix += ".";
          }

          const textStartOffset = currentOffset + indent.length + hashes.length + space.length;
          const textMatch = text.match(/^([\d\.]+)(?:\s+(.*))?$/);

          if (textMatch) {
            const existingNum = textMatch[1]!;
            const remainingText = textMatch[2] || "";

            // Check if existingNum ends with a dot (for top level) or not (for sub levels)
            // My generated 'prefix' already handles the trailing dot logic.
            // If existingNum is "1." and prefix is "1.", they match.
            // If existingNum is "1" and prefix is "1.", they don't match.
            // If existingNum is "1.1" and prefix is "1.1", they match.

            if (existingNum !== prefix) {
              const numStart = textStartOffset;
              const numEnd = numStart + existingNum.length;
              edits.push({
                start: numStart,
                end: numEnd,
                text: prefix,
              });
            }
          } else {
            // No existing number, prepend the new number
            edits.push({
              start: textStartOffset,
              end: textStartOffset,
              text: `${prefix} `,
            });
          }
        }
      }
      currentOffset += lineLength;
    }

    for (const edit of edits.reverse()) {
      index = content.update(edit.start, edit.end, edit.text, index);
    }

    return index;
  }

  getPrettierOptions(file: TFile): Options {
    const language = pluginMarkdown.languages.find(({ extensions = [] }) =>
      extensions.includes(`.${file.extension}`),
    );
    const parser = language?.name === "MDX" ? "mdx" : "markdown";
    const plugins = [
      pluginBabel,
      pluginEstree,
      pluginHtml,
      pluginMarkdown,
      pluginPostcss,
      pluginTypescript,
      pluginYaml,
    ];
    const __languageMappings = new Map(Object.entries(this.settings.languageMappings));

    return {
      parser,
      plugins,
      __languageMappings,
      ...this.settings.formatOptions,
      embeddedLanguageFormatting: this.settings.formatCodeBlock ? "auto" : "off",
    };
  }

  shouldUsePrettier(file: TFile) {
    const frontmatter = this.getFrontmatter(file);

    if (!Object.hasOwn(frontmatter, USE_PRETTIER_KEY)) {
      const ignore = this.createIgnore(this.settings.ignorePatterns);

      return !ignore.ignores(file.path);
    }

    return Boolean(frontmatter[USE_PRETTIER_KEY]);
  }

  shouldUseFastMode(file: TFile) {
    const frontmatter = this.getFrontmatter(file);

    return Boolean(frontmatter[USE_FAST_MODE_KEY]);
  }

  private getFrontmatter(file: TFile) {
    const metadata = this.app.metadataCache.getCache(file.path) || {};

    return metadata.frontmatter || {};
  }

  private createIgnore(patterns: string) {
    if (this.ignoreCache.has(patterns)) {
      return this.ignoreCache.get(patterns)!;
    }

    const ignore = createIgnore({ allowRelativePaths: true }).add(patterns);
    this.ignoreCache.set(patterns, ignore);

    return ignore;
  }
}
