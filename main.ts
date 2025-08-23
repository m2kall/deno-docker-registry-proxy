import { serve } from "std/http/server.ts";

// The official Docker Hub registry
const UPSTREAM_REGISTRY = "https://registry-1.docker.io";

// The authentication server for Docker Hub
const AUTH_SERVER = "https://auth.docker.io";

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const search = url.search;

  console.log(`[Request] ${req.method} ${path}`);

  // Serve the landing page
  if (path === "/") {
    try {
      const html = await Deno.readTextFile("index.html");
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Range",
        "Access-Control-Expose-Headers": "Docker-Content-Digest, WWW-Authenticate, Link, Content-Length, Content-Range",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // The Docker client sends a request to /v2/ to check the API version.
  // It may or may not have an auth token. We'll proxy it to the real registry.
  if (path.startsWith("/v2/")) {
    const upstreamUrl = new URL(UPSTREAM_REGISTRY + path + search);

    // Copy request headers, including the 'Authorization' header if present.
    const headers = new Headers(req.headers);
    headers.set("Host", upstreamUrl.hostname);

    try {
      const upstreamResponse = await fetch(upstreamUrl.toString(), {
        method: req.method,
        headers: headers,
        redirect: "follow", // Automatically follow redirects from the upstream
      });

      // Copy response headers from the upstream to our response.
      const responseHeaders = new Headers(upstreamResponse.headers);

      // Add headers to prevent CDN buffering and allow cross-origin requests.
      responseHeaders.set("Cache-Control", "no-store"); // Explicitly tell CDNs not to buffer
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Expose-Headers", responseHeaders.get("Access-Control-Expose-Headers") || "");


      // If the upstream sends a 401 Unauthorized, it will include a
      // 'WWW-Authenticate' header. We must pass this back to the client
      // so the client knows how to get a token.
      if (upstreamResponse.status === 401) {
        const authHeader = upstreamResponse.headers.get("WWW-Authenticate");
        if (authHeader) {
            // Modify the 'realm' in the WWW-Authenticate header to point to our proxy,
            // so the client knows where to go for authentication.
            const modifiedAuthHeader = authHeader.replace(AUTH_SERVER, url.origin);
            responseHeaders.set("WWW-Authenticate", modifiedAuthHeader);
        }
      }
      
      console.log(`[Proxy] ${path} -> ${upstreamUrl.toString()} [${upstreamResponse.status}]`);

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });

    } catch (error) {
      console.error(`[Error] Failed to proxy request: ${error.message}`);
      return new Response(JSON.stringify({ error: "Upstream request failed." }), {
        status: 502, // Bad Gateway
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  
  // Handle token requests for the auth server
  if (path.startsWith("/token")) {
    const tokenUrl = new URL(AUTH_SERVER + path + search);
    console.log(`[Auth] Proxying token request to: ${tokenUrl}`);
    try {
        const tokenResponse = await fetch(tokenUrl.toString(), {
            method: req.method,
            headers: req.headers,
        });
        return tokenResponse;
    } catch (error) {
        console.error(`[Error] Failed to proxy auth request: ${error.message}`);
        return new Response(JSON.stringify({ error: "Authentication request failed." }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
        });
    }
  }

  return new Response("Not Found", { status: 404 });
}

serve(handler, {
  onListen({ hostname, port }) {
    console.log(`🚀 Docker Registry Proxy listening on http://${hostname}:${port}`);
  },
});