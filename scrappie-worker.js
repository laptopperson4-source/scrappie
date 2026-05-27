// Scrappie — Cloudflare Worker Proxy
// Deploy at: https://dash.cloudflare.com > Workers > Create Worker
// Paste this entire file, click Save & Deploy
// Then copy your worker URL (e.g. https://scrappie.YOUR-NAME.workers.dev)
// and paste it into scrappie.html as WORKER_URL

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    try {
      // ── CLAUDE SCORING ──────────────────────────────────
      if (path === "/score") {
        const body = await request.json();
        const { postText } = body;
        if (!postText) return json({ error: "postText required" }, 400, cors);

        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 300,
            system: `You are a lead scoring AI for a custom software development agency. 
Analyse this LinkedIn post and score the buying intent 0-100.
Return ONLY valid JSON like:
{"score":85,"intent":"high","reason":"They explicitly said they need a developer to build a custom CRM","keywords":["need a developer","custom CRM"],"buyerType":"Startup founder","urgency":"high"}
Intent: high=70+, medium=40-69, low=0-39
Urgency: high (needs it now/ASAP), medium (planning), low (just exploring)
buyerType: best guess of who this person is e.g. "Startup founder", "Operations Manager", "SME owner"`,
            messages: [{ role: "user", content: "Score this post:\n\n" + postText }],
          }),
        });

        const data = await res.json();
        const text = data.content?.[0]?.text || "{}";
        const clean = text.replace(/```json|```/g, "").trim();
        try {
          return json(JSON.parse(clean), 200, cors);
        } catch {
          return json({ score: 30, intent: "low", reason: "Could not parse AI response", keywords: [], buyerType: "Unknown", urgency: "low" }, 200, cors);
        }
      }

      // ── HUNTER EMAIL FINDER ─────────────────────────────
      if (path === "/email") {
        const body = await request.json();
        const { firstName, lastName, company } = body;
        if (!firstName || !company) return json({ error: "firstName and company required" }, 400, cors);

        const hunterUrl = `https://api.hunter.io/v2/email-finder?first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName || "")}&company=${encodeURIComponent(company)}&api_key=${env.HUNTER_KEY}`;
        const res = await fetch(hunterUrl);
        const data = await res.json();

        return json({
          email: data.data?.email || null,
          confidence: data.data?.score || 0,
          sources: data.data?.sources?.length || 0,
        }, 200, cors);
      }

      // ── APOLLO EMAIL FINDER (fallback) ──────────────────
      if (path === "/apollo") {
        const body = await request.json();
        const { name, linkedinUrl } = body;

        const res = await fetch("https://api.apollo.io/v1/people/match", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
          },
          body: JSON.stringify({
            api_key: env.APOLLO_KEY,
            name,
            linkedin_url: linkedinUrl,
            reveal_personal_emails: false,
          }),
        });
        const data = await res.json();
        const person = data.person;

        return json({
          email: person?.email || null,
          phone: person?.phone_numbers?.[0]?.sanitized_number || null,
          title: person?.title || null,
          company: person?.organization?.name || null,
          confidence: person?.email_status === "verified" ? 95 : 50,
        }, 200, cors);
      }

      // ── HEALTH CHECK ────────────────────────────────────
      if (path === "/health") {
        return json({ status: "ok", service: "Scrappie Worker", version: "1.0.0" }, 200, cors);
      }

      return json({ error: "Unknown endpoint" }, 404, cors);

    } catch (e) {
      return json({ error: e.message }, 500, cors);
    }
  },
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
