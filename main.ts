import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const DOCKER_HUB = "https://registry-1.docker.io";
const AUTH_URL = "https://auth.docker.io/token";

serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  console.log(`请求: ${req.method} ${url.pathname}`);

  // CORS 预检
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // 根路径
  if (url.pathname === "/" || url.pathname === "") {
    return new Response(
      `
      <!DOCTYPE html>
      <html>
      <head><title>Docker Registry 代理</title></head>
      <body><h1>Docker Registry 代理</h1><p>使用: <code>docker pull docker.pubhub.store/仓库名称/镜像名称:版本</code></p></body>
      </html>
      `,
      { status: 200, headers: { "Content-Type": "text/html" } }
    );
  }

  // 代理 /v2/*
  if (url.pathname.startsWith("/v2/") || url.pathname === "/v2") {
    try {
      const upstreamUrl = new URL(`${DOCKER_HUB}${url.pathname}${url.search}`);
      console.log(`代理到: ${upstreamUrl}`);

      if (url.pathname === "/v2" || url.pathname === "/v2/") {
        const response = await fetch(upstreamUrl, { method: req.method, headers: req.headers });
        const authHeader = response.headers.get("WWW-Authenticate");
        if (authHeader && response.status === 401) {
          const scopeParts = url.pathname.split('/v2/')[1]?.split('/') || ['xream', 'sub-store'];
          const namespace = scopeParts[0] || 'xream';
          const repository = scopeParts[1] || 'sub-store';
          const scope = `repository:${namespace}/${repository}:pull`;
          console.log(`Scope: ${scope}`);

          const tokenParams = new URLSearchParams({ service: "registry.docker.io", scope });
          const tokenResponse = await fetch(`${AUTH_URL}?${tokenParams}`);
          if (!tokenResponse.ok) throw new Error(`Token 失败: ${tokenResponse.status}`);
          const tokenData = await tokenResponse.json();
          const token = tokenData.token;
          if (!token) throw new Error("无 Token");

          const authReq = new Request(upstreamUrl, {
            method: req.method,
            headers: { ...Object.fromEntries(req.headers), "Authorization": `Bearer ${token}` },
          });
          const authResponse = await fetch(authReq);
          const newHeaders = new Headers(authResponse.headers);
          newHeaders.set("Access-Control-Allow-Origin", "*");
          return new Response(authResponse.body, { status: authResponse.status, headers: newHeaders });
        }
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(response.body, { status: response.status, headers: newHeaders });
      }

      const proxyReq = new Request(upstreamUrl, { method: req.method, headers: req.headers });
      const response = await fetch(proxyReq);
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, { status: response.status, headers: newHeaders });
    } catch (error) {
      console.error("错误:", error.message);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  return new Response("未找到", { status: 404, headers: { "Content-Type": "text/plain" } });
});
