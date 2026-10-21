// Supabase Edge Function: ingest-feeds
// Deploy with Supabase CLI or paste into the Edge Functions editor.
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: OPENAI_API_KEY, SUMMARY_MODEL
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const openAiKey = Deno.env.get("OPENAI_API_KEY");
const summaryModel = Deno.env.get("SUMMARY_MODEL") ?? "gpt-4.1-mini";
const supabase = createClient(supabaseUrl, serviceKey);

function decodeXml(s: string) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function tag(xml: string, name: string) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = xml.match(re);
  return m ? decodeXml(m[1].replace(/<[^>]+>/g, " ").trim()) : "";
}
function entries(xml: string) {
  const rss = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
  const atom = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map(m => m[1]);
  return (rss.length ? rss : atom).slice(0, 50).map(item => {
    const linkTag = item.match(/<link\b([^>]*)\/?>/i);
    let link = tag(item, "link");
    if (linkTag && !link && /href=/i.test(linkTag[1])) link = (linkTag[1].match(/href=["']([^"']+)/i) || [])[1] || "";
    const date = tag(item, "pubDate") || tag(item, "published") || tag(item, "updated") || tag(item, "dc:date");
    const id = tag(item, "guid") || tag(item, "id") || link;
    const desc = tag(item, "description") || tag(item, "summary") || tag(item, "content");
    return { id, title: tag(item, "title") || "Untitled update", link, date, description: desc.slice(0, 5000) };
  }).filter(x => x.link && /^https?:\/\//i.test(x.link));
}
function cleanHtml(value: string): string {
  return decodeXml(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

async function fetchArchbishopNews() {
  const found = new Map<string, {
    id: string;
    title: string;
    link: string;
    date: string;
    description: string;
  }>();

  // Read several pages of the official news listing.
  for (let page = 0; page < 5; page++) {
    const url =
      `https://www.archbishopofcanterbury.org/news?page=${page}`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "ArchangelFeedBot/1.0 (RSS reader)",
        "Accept": "text/html"
      },
      signal: AbortSignal.timeout(12000)
    });

    if (!response.ok) {
      throw new Error(`Archbishop news page returned HTTP ${response.status}`);
    }

    const html = await response.text();

    const anchors = /<a\b([^>]*href=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = anchors.exec(html)) !== null) {
      const href = match[2];
      const title = cleanHtml(match[3]);

      if (!title || title.length < 12 || title.length > 300) continue;

      let link: URL;
      try {
        link = new URL(href, "https://www.archbishopofcanterbury.org");
      } catch {
        continue;
      }

      if (link.hostname !== "www.archbishopofcanterbury.org") continue;

      // Accept individual news articles and speeches, not generic site pages.
      if (!/^\/(news|speeches)\/[^/?#]+\/?$/.test(link.pathname)) continue;

      const articleUrl = link.origin + link.pathname.replace(/\/$/, "");
      if (found.has(articleUrl)) continue;

      // Try to find a date in the nearby article-card markup.
      const nearby = html.slice(
        Math.max(0, match.index - 1200),
        Math.min(html.length, anchors.lastIndex + 1200)
      );

      const dateMatch =
        nearby.match(/datetime=["']([^"']+)["']/i) ||
        nearby.match(/(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/);

      found.set(articleUrl, {
        id: articleUrl,
        title,
        link: articleUrl,
        date: dateMatch?.[1] || "",
        description: ""
      });
    }
  }

  return [...found.values()].slice(0, 100);
} 
async function makeSummary(title: string, description: string) {
  const fallback = (description || title).replace(/\s+/g, " ").slice(0, 420);
  if (!openAiKey) return { summary: fallback || title, ai: false };
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openAiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: summaryModel,
        messages: [
          { role: "system", content: "Write a neutral, accurate 1-2 sentence summary of the supplied public feed item. Do not add facts not present in the text. If details are insufficient, say what the item announces without speculation. Return only the summary." },
          { role: "user", content: `Title: ${title}\nFeed excerpt: ${description.slice(0, 3500)}` }
        ],
        temperature: 0.2,
        max_tokens: 120
      })
    });
    if (!res.ok) throw new Error(`Summary API returned ${res.status}`);
    const json = await res.json();
    const summary = json.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error("Empty summary");
    return { summary, ai: true };
  } catch (e) {
    console.error("Summary fallback:", e);
    return { summary: fallback || title, ai: false };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Use POST", { status: 405 });
  const expected = Deno.env.get("INGEST_SECRET");
  if (expected && req.headers.get("x-ingest-secret") !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { data: sources, error } = await supabase.from("sources")
    .select("*").eq("enabled", true).limit(100);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  let added = 0, checked = 0, failed = 0;
  for (const source of sources ?? []) {
    try {
      const response = await fetch(source.feed_url, {
        headers: { "User-Agent": "ArchangelFeedBot/1.0 (RSS reader)" },
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}`);
      const xml = await response.text();
      if (!xml.includes("<rss") && !xml.includes("<feed") && !xml.includes("<RDF")) {
        throw new Error("Response does not look like RSS/Atom XML");
      }
      const items = entries(xml);
      checked++;
      for (const item of items) {
        const { data: existing } = await supabase.from("stories").select("id")
          .eq("story_url", item.link).maybeSingle();
        if (existing) continue;
        const summary = await makeSummary(item.title, item.description);
        const published = item.date && !Number.isNaN(Date.parse(item.date))
          ? new Date(item.date).toISOString() : null;
        const { error: insertError } = await supabase.from("stories").insert({
          source_id: source.id, external_id: item.id || item.link,
          title: item.title.slice(0, 500), summary: summary.summary,
          story_url: item.link, published_at: published,
          tradition: source.tradition, content_type: source.source_type === "social" ? "Social post" :
            source.source_type === "official" ? "Official statement" : "News coverage",
          summary_is_ai: summary.ai
        });
        if (!insertError) added++;
        else if (!String(insertError.message).toLowerCase().includes("duplicate")) console.error(insertError);
      }
      await supabase.from("sources").update({ last_checked_at: new Date().toISOString(), last_error: null }).eq("id", source.id);
    } catch (e) {
      failed++;
      await supabase.from("sources").update({ last_checked_at: new Date().toISOString(), last_error: String(e).slice(0, 500) }).eq("id", source.id);
    }
  }
  return Response.json({ ok: true, sources_checked: checked, stories_added: added, sources_failed: failed });
});
