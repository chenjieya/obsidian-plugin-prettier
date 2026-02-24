import COS from "cos-js-sdk-v5";
import { Notice, requestUrl } from "obsidian";

import type PrettierPlugin from "./main";
import type { MagicString } from "./utils/string";
import type { TFile } from "obsidian";

interface ImageMatch {
  alt: string;
  url: string;
  start: number;
  end: number;
  urlStart: number;
  urlEnd: number;
}

export class ImageUploader {
  private plugin: PrettierPlugin;
  private cos: any;
  private failedUrls: Set<string> = new Set();

  constructor(plugin: PrettierPlugin) {
    this.plugin = plugin;
  }

  async uploadImages(content: MagicString, file: TFile, offset = -1) {
    if (!this.plugin.settings.tencentCos) {
      return offset;
    }

    const { bucket, region, domain } = this.plugin.settings.tencentCos;

    if (!bucket || !region) {
      return offset;
    }

    if (!this.initCos()) return offset;

    const matches = this.findImageMatches(content.original);
    if (matches.length === 0) return offset;

    let index = offset;
    const uploads: Promise<{ match: ImageMatch; newUrl: string | null }>[] = [];

    for (const match of matches) {
      const shouldUpload = this.shouldUpload(match.url, domain || "");
      const logMessage = `[ImageUploader] Original: ${match.url}, Should Upload: ${shouldUpload ? "Yes" : "No"}`;
      console.log(logMessage);

      if (shouldUpload) {
        uploads.push(
          this.uploadImage(match.url, file).then(newUrl => {
            console.log(
              `[ImageUploader] Result - Original: ${match.url}, New: ${newUrl || "Failed"}`,
            );
            return {
              match,
              newUrl,
            };
          }),
        );
      }
    }

    const results = await Promise.all(uploads);

    // Apply replacements in reverse order to preserve indices
    results.sort((a, b) => b.match.start - a.match.start);

    for (const { match, newUrl } of results) {
      if (newUrl) {
        index = content.update(match.urlStart, match.urlEnd, newUrl, index);
      }
    }

    const uploadedCount = results.filter(r => r.newUrl).length;
    if (uploadedCount > 0) {
      // eslint-disable-next-line no-new
      new Notice(`Uploaded ${uploadedCount} images to Tencent COS.`);
    } else {
      console.log("[ImageUploader] No images uploaded.");
    }

    return index;
  }

  private initCos() {
    if (!this.plugin.settings.tencentCos) {
      return false;
    }
    const { secretId, secretKey } = this.plugin.settings.tencentCos;
    if (!secretId || !secretKey) {
      return false;
    }

    if (!this.cos) {
      this.cos = new COS({
        SecretId: secretId,
        SecretKey: secretKey,
      });
    }
    return true;
  }

  private findImageMatches(text: string): ImageMatch[] {
    const regex = /!\[(.*?)\]\((.*?)\)/g;
    const matches: ImageMatch[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      const alt = match[1] || "";
      const url = match[2] || "";
      const start = match.index;
      const end = start + match[0].length;
      // ![alt](url)
      // start is at !
      // urlStart is after ![alt](
      const urlStart = start + 2 + alt.length + 2;
      const urlEnd = urlStart + url.length;

      matches.push({
        alt,
        url,
        start,
        end,
        urlStart,
        urlEnd,
      });
    }

    // Also match HTML <img> tags
    // <img src="url" ... />
    // This regex is simplified and might not catch all cases (like newlines in attributes), but works for standard cases
    const imgTagRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/g;

    // We need to iterate again or reuse 'match' variable
    let imgMatch;
    while ((imgMatch = imgTagRegex.exec(text)) !== null) {
      const url = imgMatch[1] || "";
      const start = imgMatch.index;
      const end = start + imgMatch[0].length;

      // We need to find the exact position of the URL inside the match to replace it later
      // match[0] is the whole tag <img ... src="url" ... >
      // We need to find "url" inside match[0] and calculate offset
      // Be careful if url appears multiple times in the tag (unlikely for src)
      // But more robust way: find "src=" then find the quote then the url

      const srcIndex = imgMatch[0].indexOf(url);
      if (srcIndex !== -1) {
        const urlStart = start + srcIndex;
        const urlEnd = urlStart + url.length;

        matches.push({
          alt: "", // HTML img tags might have alt in another attribute, but for replacement we don't strictly need it
          url,
          start,
          end,
          urlStart,
          urlEnd,
        });
      }
    }

    return matches;
  }

  private shouldUpload(url: string, domain: string): boolean {
    if (this.failedUrls.has(url)) {
      console.log(`[ImageUploader] Skipping failed URL: ${url}`);
      return false;
    }
    if (url.startsWith("http")) {
      // 1. Check custom domain
      if (domain && url.includes(domain)) {
        return false;
      }

      // 2. Check standard COS domain
      if (this.plugin.settings.tencentCos) {
        const { bucket, region } = this.plugin.settings.tencentCos;
        if (bucket && region) {
          const standardDomain = `${bucket}.cos.${region}.myqcloud.com`;
          if (url.includes(standardDomain)) {
            return false;
          }
        }
      }
      return true;
    }
    // It's a local file path
    return true;
  }

  private async uploadImage(url: string, file: TFile): Promise<string | null> {
    if (!this.plugin.settings.tencentCos) {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let filename = "";

    try {
      let body: ArrayBuffer;

      if (url.startsWith("http")) {
        // External URL
        const response = await requestUrl({ url });
        body = response.arrayBuffer;
        // Guess filename from url or content-type
        filename = url.split("/").pop()?.split("?")[0] || `image-${Date.now()}.png`;
      } else {
        // Local file
        // Resolve path relative to current file or vault root
        const linkPath = url.split("#")[0]!.split("?")[0]!;
        const linkedFile = this.plugin.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
        if (!linkedFile) {
          // Cannot find local file
          return null;
        }
        body = await this.plugin.app.vault.readBinary(linkedFile);
        filename = linkedFile.name;
      }

      const { secretId, secretKey, bucket, region, domain } = this.plugin.settings.tencentCos;
      if (!bucket || !region) {
        return null;
      }
      const key = `obsidian/${Date.now()}_${filename}`;
      const uploadUrl = `https://${bucket}.cos.${region}.myqcloud.com/${key}`;

      // Use requestUrl to bypass CORS
      const authorization = COS.getAuthorization({
        SecretId: secretId,
        SecretKey: secretKey,
        Method: "put",
        Key: key,
        Pathname: `/${key}`,
      });

      const response = await requestUrl({
        url: uploadUrl,
        method: "PUT",
        headers: {
          Authorization: authorization,
          "Content-Type": "", // Let it be inferred or empty
        },
        body: body,
      });

      if (response.status >= 200 && response.status < 300) {
        if (domain) {
          const cleanDomain = domain.replace(/\/$/, "");
          return `${cleanDomain}/${key}`;
        } else {
          return uploadUrl;
        }
      } else {
        console.error("COS Upload Error:", response.status, response.text);
        this.failedUrls.add(url);
        // eslint-disable-next-line no-new
        new Notice(`Failed to upload image: ${filename}`);
        return null;
      }
    } catch (error) {
      console.error("Upload Image Error:", error);
      this.failedUrls.add(url);
      return null;
    }
  }
}
