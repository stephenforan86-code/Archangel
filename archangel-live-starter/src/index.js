/**
 * Archangel Worker: static assets + Stripe Checkout session creation.
 * Keep STRIPE_SECRET_KEY in Cloudflare Worker secrets, never in public files.
 */
const ALLOWED = {
  GBP: { once: [299, 499, 999, 1999], monthly: [299, 499, 999, 1999] },
  USD: { once: [500, 1000, 2000], monthly: [500, 1000, 2000] }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/create-checkout-session") {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "Invalid request origin." }, 403);
      if (!env.STRIPE_SECRET_KEY) return json({ error: "Stripe is not configured yet." }, 503);

      let body;
      try { body = await request.json(); }
      catch { return json({ error: "Invalid request body." }, 400); }

      const currency = String(body.currency || "").toUpperCase();
      const frequency = String(body.frequency || "");
      const isCustom = body.custom === true;
      const amount = Number(body.amount);

      if (!["GBP", "USD"].includes(currency) || !["once", "monthly"].includes(frequency)) {
        return json({ error: "Unsupported currency or payment frequency." }, 400);
      }
      if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) {
        return json({ error: "Amount must be between 1 and 10,000." }, 400);
      }
      if (isCustom && frequency !== "once") {
        return json({ error: "Custom amounts are available for one-off contributions only." }, 400);
      }

      const minorAmount = Math.round(amount * 100);
      const permitted = ALLOWED[currency][frequency];
      if (!(isCustom && frequency === "once") && !permitted.includes(minorAmount)) {
        return json({ error: "That contribution amount is not available." }, 400);
      }
      if (isCustom && Math.abs(amount * 100 - minorAmount) > 0.00001) {
        return json({ error: "Use an amount with no more than two decimal places." }, 400);
      }

      const params = new URLSearchParams();
      params.set("mode", frequency === "monthly" ? "subscription" : "payment");
      params.set("line_items[0][quantity]", "1");
      params.set("line_items[0][price_data][currency]", currency.toLowerCase());
      params.set("line_items[0][price_data][unit_amount]", String(minorAmount));
      params.set("line_items[0][price_data][product_data][name]", "Support Archangel");
      params.set("line_items[0][price_data][product_data][description]", "Voluntary contribution towards Archangel website running costs.");
      if (frequency === "monthly") params.set("line_items[0][price_data][recurring][interval]", "month");
      params.set("success_url", `${url.origin}/?support=success&session_id={CHECKOUT_SESSION_ID}`);
      params.set("cancel_url", `${url.origin}/?support=cancelled`);

      const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      });

      const stripeData = await stripeResponse.json().catch(() => ({}));
      if (!stripeResponse.ok || !stripeData.url) {
        console.error("Stripe Checkout session creation failed", stripeData.error?.type || stripeResponse.status);
        return json({ error: "Stripe could not start checkout. Check the Worker secret and Stripe test-mode setup." }, 502);
      }
      return json({ url: stripeData.url });
    }

    // Serve existing static site assets for all non-API requests.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Archangel assets binding is missing.", { status: 500 });
  }
};
