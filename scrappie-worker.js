// Scrappie — Cloudflare Worker
// ─────────────────────────────────────────────────────────────
// DEPLOYMENT INSTRUCTIONS (do NOT use Pages — use Workers):
//
// 1. Go to dash.cloudflare.com
// 2. Click "Workers & Pages" in the left sidebar
// 3. Click "Create" then choose "Worker" (NOT Pages)
// 4. Click "Create Worker" — give it any name e.g. "scrappie"
// 5. Click "Edit code" on the next screen
// 6. Delete ALL the default code
// 7. Paste this entire file
// 8. Click "Deploy"
// 9. Copy the worker URL shown (e.g. https://scrappie.yourname.workers.dev)
//
// Then add your secret keys:
// Go to Worker > Settings > Variables and Secrets > Add:
//   GROQ_KEY   = your Groq API key
//   SKRAPP_KEY = your Skrapp.io API key (optional)
// ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {

    // CORS preflight
    if (request.method === "OPTIONS") {
      return cors(null, 204);
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {

      // ── HEALTH ──────────────────────────────────────────────
      if (path === "/health") {
        return cors(json({ status: "ok", version: "2.0.0", ai: "groq" }));
      }

      // ── AI SCORING via Groq ─────────────────────────────────
      if (path === "/score") {
        const { postText } = await request.json();
        if (!postText) return cors(json({ error: "postText required" }, 400));

        const prompt = `You are a lead scoring AI for a custom software development agency.
Analyse this LinkedIn post and score the buying intent from 0 to 100.
Return ONLY valid JSON — no markdown, no explanation, just the JSON object:
{
  "score": 85,
  "intent": "high",
  "reason": "one sentence explanation",
  "keywords": ["matched phrase 1", "matched phrase 2"],
  "buyerType": "e.g. Startup Founder, Operations Manager, SME Owner",
  "urgency": "high"
}
Rules:
- score 70-100 = high intent (actively looking to buy/build)
- score 40-69  = medium intent (exploring, planning)
- score 0-39   = low intent (general discussion)
- urgency: high = needs it now/ASAP, medium = planning soon, low = exploring
- buyerType: best guess from context`;

        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + env.GROQ_KEY,
          },
          body: JSON.stringify({
            model: "llama3-70b-8192",
            temperature: 0.1,
            max_tokens: 300,
            messages: [
              { role: "system", content: prompt },
              { role: "user",   content: "Score this LinkedIn post:\n\n" + postText.slice(0, 1500) }
            ]
          })
        });

        if (!res.ok) {
          const err = await res.text();
          console.error("Groq error:", err);
          return cors(json(fallbackScore(postText)));
        }

        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || "{}";
        try {
          const clean = text.replace(/```json|```/g, "").trim();
          return cors(json(JSON.parse(clean)));
        } catch {
          return cors(json(fallbackScore(postText)));
        }
      }

      // ── EMAIL ENRICHMENT ────────────────────────────────────
      if (path === "/email") {
        const body = await request.json();
        const { firstName, lastName, company, linkedinUrl, service } = body;

        // Skrapp.io
        if (service === "skrapp" && env.SKRAPP_KEY) {
          const r = await fetch("https://api.skrapp.io/api/v2/find", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Access-Key": env.SKRAPP_KEY
            },
            body: JSON.stringify({
              firstName,
              lastName,
              domain: companyToDomain(company)
            })
          });
          if (r.ok) {
            const d = await r.json();
            if (d.email) return cors(json({ email: d.email, confidence: d.accuracy || 70, source: "Skrapp" }));
          }
        }

        // Findymail
        if (service === "findymail" && env.FINDYMAIL_KEY) {
          const r = await fetch("https://app.findymail.com/api/search/name", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + env.FINDYMAIL_KEY
            },
            body: JSON.stringify({
              name: firstName + " " + lastName,
              domain: companyToDomain(company)
            })
          });
          if (r.ok) {
            const d = await r.json();
            if (d.email) return cors(json({ email: d.email, confidence: 80, source: "Findymail" }));
          }
        }

        // Prospeo
        if (service === "prospeo" && env.PROSPEO_KEY) {
          const r = await fetch("https://api.prospeo.io/email-finder", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-KEY": env.PROSPEO_KEY
            },
            body: JSON.stringify({
              first_name: firstName,
              last_name: lastName,
              company
            })
          });
          if (r.ok) {
            const d = await r.json();
            const email = d.response?.email;
            if (email) return cors(json({ email, confidence: 75, source: "Prospeo" }));
          }
        }

        return cors(json({ email: null }));
      }

      return cors(json({ error: "Unknown endpoint" }, 404));

    } catch (e) {
      console.error(e);
      return cors(json({ error: e.message }, 500));
    }
  }
};

// ─── Helpers ──────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function cors(response, status) {
  // If called with just data object (not a Response), wrap it
  if (!(response instanceof Response)) {
    response = json(response || {}, status || 200);
  }
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return r;
}

function companyToDomain(company) {
  if (!company) return "";
  return company.toLowerCase()
    .replace(/\s+(inc|ltd|llc|corp|co|limited|group|technologies|tech|solutions|services)\.?$/i, "")
    .trim()
    .replace(/\s+/g, "") + ".com";
}

function fallbackScore(text) {
  const l = text.toLowerCase();
  let s = 20;
  const found = [];
  const HI = ["need a developer","need to build","hire a developer","need a custom","need software","need an app","need to automate","looking for a dev","build us a","need a platform","need technical","fractional cto"];
  const MED = ["automate","custom tool","saas","web app","mobile app","workflow","api","integration","no-code","tech solution","crm","dashboard"];
  HI.forEach(k  => { if (l.includes(k))  { s += 18; found.push(k); } });
  MED.forEach(k => { if (l.includes(k))  { s += 7;  found.push(k); } });
  s = Math.min(100, s);
  return {
    score: s,
    intent: s >= 70 ? "high" : s >= 40 ? "medium" : "low",
    reason: "Keyword-based fallback scoring",
    keywords: found.slice(0, 4),
    buyerType: "Unknown",
    urgency: l.includes("asap") || l.includes("urgent") ? "high" : "low"
  };
}
