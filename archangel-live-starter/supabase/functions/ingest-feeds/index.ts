// Supabase Edge Function: ingest-feeds
// Deploy with Supabase CLI or paste this entire file into the Edge Functions editor.
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional secrets: OPENAI_API_KEY, SUMMARY_MODEL, INGEST_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const openAiKey = Deno.env.get("OPENAI_API_KEY");
const summaryModel = Deno.env.get("SUMMARY_MODEL") ?? "gpt-4.1-mini";
const supabase = createClient(supabaseUrl, serviceKey);

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function tag(xml: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escapedName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedName}>`, "i");
  const match = xml.match(re);
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, " ").trim()) : "";
}

function firstImageUrl(value: string): string | null {
  if (!value) return null;
  const candidate = decodeXml(value.trim());
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function extractImageFromHtml(value: string): string | null {
  if (!value) return null;
  const img = value.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i);
  return firstImageUrl(img?.[1] ?? "");
}

function entries(xml: string) {
  const rss = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const atom = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);

  return (rss.length ? rss : atom).slice(0, 50).map((item) => {
    const linkTag = item.match(/<link\b([^>]*)\/?\s*>/i);
    let link = tag(item, "link");

    // Atom feeds commonly store the URL in a link href attribute.
    if (linkTag && !link && /href=/i.test(linkTag[1])) {
      link = (linkTag[1].match(/href=["']([^"']+)/i) || [])[1] || "";
    }

    const date = tag(item, "pubDate") || tag(item, "published") || tag(item, "updated") || tag(item, "dc:date");
    const id = tag(item, "guid") || tag(item, "id") || link;
    const desc = tag(item, "description") || tag(item, "summary") || tag(item, "content:encoded") || tag(item, "content");

    // RSS media extensions and standard image enclosures.
    const mediaImage = item.match(/<(?:media:thumbnail|media:content)\b[^>]*\burl=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1];
    const enclosure = [...item.matchAll(/<enclosure\b([^>]*)\/?\s*>/gi)]
      .map((m) => m[1])
      .find((attrs) => /type=["']image\//i.test(attrs));
    const enclosureImage = enclosure?.match(/\burl=["']([^"']+)["']/i)?.[1];

    // Some publishers place the article image directly in the description/content.
    const descriptionImage = extractImageFromHtml(desc);
    const imageUrl = firstImageUrl(mediaImage || enclosureImage || "") || descriptionImage;

    return {
      id,
      title: tag(item, "title") || "Untitled update",
      link,
      date,
      description: desc.slice(0, 5000),
      imageUrl,
    };
  }).filter((item) => item.link && /^https?:\/\//i.test(item.link));
}

function cleanHtml(value: string): string {
  return decodeXml(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}
