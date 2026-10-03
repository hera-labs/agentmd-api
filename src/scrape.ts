/**
 * scrape.ts
 * ---------
 * Fetch a public web page, strip noisy chrome (scripts, ads, nav),
 * and convert the main content to Markdown with Turndown.
 *
 * Safety (SSRF / abuse basics):
 * - Only http: and https: URLs
 * - Block localhost, private IPs, link-local, metadata endpoints
 * - Timeout + max response size
 *
 * robots.txt / Terms of Service:
 * Respect site ToS and robots.txt for production use. This tool is a
 * technical converter for pages the caller is allowed to fetch — it does
 * not bypass paywalls, logins, or access controls.
 */

import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 1_500_000; // ~1.5 MB HTML cap

export interface ScrapeResult {
  markdown: string;
  url: string;
  title: string | null;
  meta: {
    contentType: string | null;
    fetchedAt: string;
    bytes: number;
    truncated: boolean;
  };
}

export class ScrapeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ScrapeError";
    this.status = status;
  }
}

function isPrivateIp(ip: string): boolean {
  // IPv4 private / special ranges
  if (ip.includes(".")) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // IPv6: localhost, unique-local, link-local
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true;
  return false;
}

async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ScrapeError("Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ScrapeError("Only http and https URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new ScrapeError("URLs with embedded credentials are not allowed.");
  }

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  ) {
    throw new ScrapeError("Private / local hosts are blocked (SSRF protection).");
  }

  // If hostname is already an IP literal, check it directly.
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new ScrapeError("Private IP addresses are blocked (SSRF protection).");
    }
    return url;
  }

  // Resolve DNS and reject if any A/AAAA is private.
  try {
    const records = await lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateIp(r.address)) {
        throw new ScrapeError(
          "URL resolves to a private IP and is blocked (SSRF protection)."
        );
      }
    }
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    throw new ScrapeError(`Could not resolve host: ${host}`, 400);
  }

  return url;
}

function stripNoise($: cheerio.CheerioAPI) {
  // Remove elements that usually are not useful article content.
  $(
    [
      "script",
      "style",
      "noscript",
      "iframe",
      "object",
      "embed",
      "svg",
      "canvas",
      "nav",
      "footer",
      "header",
      "aside",
      "form",
      "button",
      "[role='navigation']",
      "[role='banner']",
      "[role='contentinfo']",
      ".advertisement",
      ".ads",
      ".ad",
      "#cookie-banner",
      ".cookie",
    ].join(",")
  ).remove();

  // Strip on* handlers and javascript: hrefs
  $("*").each((_, el) => {
    const attribs = (el as any).attribs || {};
    for (const name of Object.keys(attribs)) {
      if (name.toLowerCase().startsWith("on")) {
        $(el).removeAttr(name);
      }
    }
    const href = $(el).attr("href");
    if (href && href.trim().toLowerCase().startsWith("javascript:")) {
      $(el).removeAttr("href");
    }
  });
}

function pickMainHtml($: cheerio.CheerioAPI): string {
  const candidates = ["article", "main", "[role='main']", "#content", ".content", "body"];
  for (const sel of candidates) {
    const node = $(sel).first();
    if (node.length && node.text().trim().length > 80) {
      return node.html() || "";
    }
  }
  return $("body").html() || $.root().html() || "";
}

export async function scrapeToMarkdown(rawUrl: string): Promise<ScrapeResult> {
  const url = await assertSafeUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Identify as a bot — polite + debuggable. Adjust if you brand differently.
        "User-Agent": "AgentMD/1.0 (+https://github.com/your-org/agentmd; technical scraper)",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ScrapeError("Fetch timed out.", 504);
    }
    throw new ScrapeError(
      `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new ScrapeError(`Upstream HTTP ${res.status}`, 502);
  }

  const contentType = res.headers.get("content-type");
  if (
    contentType &&
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml") &&
    !contentType.includes("text/plain")
  ) {
    throw new ScrapeError(`Unsupported content-type: ${contentType}`, 415);
  }

  // Cap body size without loading unbounded streams into memory.
  const reader = res.body?.getReader();
  if (!reader) {
    throw new ScrapeError("Empty response body.", 502);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      truncated = true;
      // Keep what we have up to the cap
      const over = total - MAX_BYTES;
      chunks.push(value.slice(0, Math.max(0, value.byteLength - over)));
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
  }

  const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim() || null;
  stripNoise($);
  const mainHtml = pickMainHtml($);

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // Drop images with tracking pixels etc. — keep alt text as markdown image if useful
  turndown.addRule("stripEmptyImages", {
    filter: (node) =>
      node.nodeName === "IMG" &&
      !(node as HTMLElement).getAttribute?.("alt")?.trim(),
    replacement: () => "",
  });

  let markdown = turndown.turndown(mainHtml || "").trim();
  if (title) {
    markdown = `# ${title}\n\n${markdown}`;
  }

  return {
    markdown,
    url: url.toString(),
    title,
    meta: {
      contentType,
      fetchedAt: new Date().toISOString(),
      bytes: total,
      truncated,
    },
  };
}
