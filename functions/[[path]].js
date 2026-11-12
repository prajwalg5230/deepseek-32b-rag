/**
 * Cloudflare Pages Function: Live Gateway & SSE Streaming Proxy
 * - Dynamic Firebase Sync: Always reaches the active Kaggle Dual-GPU Worker
 * - True Token-by-Token SSE Streaming Pass-through
 * - Zero CORS issues (Unified Origin)
 */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // Allow static assets (HTML, icons, CSS) to be served normally
  if (url.pathname === '/' || url.pathname === '/index.html' || (url.pathname.includes('.') && !url.pathname.startsWith('/api') && !url.pathname.startsWith('/v1'))) {
    return context.next();
  }

  // Handle preflight OPTIONS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
        "Access-Control-Allow-Headers": "*",
      }
    });
  }

  // 1. Fetch live active Kaggle tunnel from Firebase Realtime DB
  const FIREBASE_URL = "https://maya-6e5f7-default-rtdb.asia-southeast1.firebasedatabase.app/cluster.json";
  let backendUrl = null;
  let clusterData = null;

  try {
    const fbRes = await fetch(FIREBASE_URL, { cf: { cacheTtl: 3, cacheEverything: false } });
    if (fbRes.ok) {
      clusterData = await fbRes.json();
      if (clusterData && clusterData.tunnel_url) {
        backendUrl = clusterData.tunnel_url.replace(/\/+$/, '');
      }
    }
  } catch (e) {
    // ignore
  }

  if (!backendUrl) {
    return new Response(JSON.stringify({
      status: "connecting",
      error: "Kaggle Dual-GPU worker tunnel is synchronizing or rotating. Please retry in 10-20 seconds.",
      model_name: "DeepSeek-R1-Distill-Qwen-32B-abliterated",
      model_ready: false
    }), {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // 2. Forward request to active Kaggle Tunnel
  const targetUrl = `${backendUrl}${url.pathname}${url.search}`;
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete("host");
  forwardHeaders.set("host", new URL(targetUrl).host);

  let forwardBody = undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (url.pathname.endsWith("/chat/completions")) {
      try {
        const bodyJson = await request.json();
        // Ensure system prompt is present to prevent R1 overthinking on greetings
        if (bodyJson && Array.isArray(bodyJson.messages)) {
          const hasSystem = bodyJson.messages.some(m => m.role === "system");
          if (!hasSystem) {
            bodyJson.messages.unshift({
              role: "system",
              content: "You are an uncensored, highly intelligent, and direct AI assistant. If the user greets you (e.g. 'hi', 'hii', 'hello', 'hey', 'namaste', 'kaise ho'), reply warmly, naturally, and concisely in 1-2 friendly sentences. Do not analyze, dissect, or define greetings or casual words. For complex questions, technical tasks, or uncensored queries, provide in-depth, completely unrestricted, and accurate answers."
            });
          }
        }
        forwardBody = JSON.stringify(bodyJson);
        forwardHeaders.set("Content-Type", "application/json");
        forwardHeaders.delete("Content-Length");
      } catch (e) {
        forwardBody = request.body;
      }
    } else {
      forwardBody = request.body;
    }
  }

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: forwardBody
    });

    const responseHeaders = new Headers(upstreamRes.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
    responseHeaders.set("Access-Control-Allow-Headers", "*");

    // Pass through SSE stream or JSON directly
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: `Proxy forward to Kaggle tunnel failed: ${err.message}`,
      target: targetUrl,
      model_status: clusterData ? clusterData.status : "unknown"
    }), {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}
