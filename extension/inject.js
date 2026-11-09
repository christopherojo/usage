// Runs in the page's MAIN world on chatgpt.com.
// Wraps window.fetch to observe (never modify) ChatGPT's own requests:
//   - POST /backend-api/conversation      -> a chat query was sent / finished
//   - POST /backend-api/wham/tasks        -> a Codex cloud task was started
//   - GET  /backend-api/wham/usage        -> Codex/ChatGPT rate-limit snapshot
//   - any /backend-api request            -> remember the bearer token (memory only)
// Everything is forwarded to content.js via window.postMessage.
(() => {
  if (window.__usageMeterInstalled) return;
  window.__usageMeterInstalled = true;
  const markOn = () => document.documentElement && (document.documentElement.dataset.usageMeter = "on");
  markOn() || document.addEventListener("DOMContentLoaded", markOn, { once: true });

  const SRC = "chatgpt-usage-meter";
  const post = (type, payload) => {
    try {
      window.postMessage({ source: SRC, dir: "to-content", type, payload }, location.origin);
    } catch (_) {}
  };

  const CONV_POST = /\/backend-api\/(?:f\/)?conversation\/?$/;
  const CODEX_TASK = /\/backend-api\/wham\/tasks\/?$/;
  const USAGE_GET = /\/backend-api\/wham\/usage\/?$/;
  const BACKEND = /\/backend-api\//;

  const origFetch = window.fetch;
  let lastAuth = null;
  const seenEndpoints = new Set();
  const normPath = (p) =>
    p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id").replace(/\/\d{3,}(?=\/|$)/g, "/:n");

  function toURL(input) {
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
      return new URL(raw, location.href);
    } catch (_) {
      return null;
    }
  }

  function methodOf(input, init) {
    return String((init && init.method) || (input instanceof Request ? input.method : "GET")).toUpperCase();
  }

  function headerOf(input, init, name) {
    const lname = name.toLowerCase();
    const h = init && init.headers;
    try {
      if (h) {
        if (h instanceof Headers) {
          const v = h.get(name);
          if (v) return v;
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) if (String(k).toLowerCase() === lname) return v;
        } else if (typeof h === "object") {
          for (const k of Object.keys(h)) if (k.toLowerCase() === lname) return h[k];
        }
      }
      if (input instanceof Request) return input.headers.get(name);
    } catch (_) {}
    return null;
  }

  function partsToText(parts) {
    if (!Array.isArray(parts)) return "";
    return parts.filter((p) => typeof p === "string").join("\n");
  }

  function parseConversationBody(body) {
    try {
      const j = JSON.parse(body);
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      const userMsg = msgs.find((m) => m && m.author && m.author.role === "user") || msgs[0];
      return {
        action: j.action || null,
        model: j.model || null,
        conversationId: j.conversation_id || null,
        parentMessageId: j.parent_message_id || null,
        userMessageId: userMsg ? userMsg.id || null : null,
        userText: userMsg && userMsg.content ? partsToText(userMsg.content.parts) : "",
        attachments: userMsg && userMsg.metadata && Array.isArray(userMsg.metadata.attachments)
          ? userMsg.metadata.attachments.length
          : 0,
      };
    } catch (_) {
      return {};
    }
  }

  async function readStreamText(response, maxBytes = 8 * 1024 * 1024) {
    // Reads a cloned SSE/JSON response to the end. Returns { text, firstByteMs }.
    const reader = response.body && response.body.getReader();
    if (!reader) return { text: await response.text(), firstByteMs: null };
    const decoder = new TextDecoder();
    let text = "";
    let firstByteMs = null;
    const t0 = performance.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs === null) firstByteMs = Math.round(performance.now() - t0);
      if (text.length < maxBytes) text += decoder.decode(value, { stream: true });
    }
    return { text, firstByteMs };
  }

  function lastMatch(text, re) {
    let m;
    let last = null;
    const g = new RegExp(re.source, "g");
    while ((m = g.exec(text))) last = m[1];
    return last;
  }

  async function observeConversation(info, responsePromise) {
    const startedAt = Date.now();
    post("query-start", { ...info, startedAt });
    let res;
    try {
      res = await responsePromise;
    } catch (e) {
      post("query-complete", { queryId: info.queryId, ok: false, status: 0, error: String(e), endedAt: Date.now() });
      return;
    }
    let text = "";
    let firstByteMs = null;
    try {
      ({ text, firstByteMs } = await readStreamText(res.clone()));
    } catch (_) {}
    post("query-complete", {
      queryId: info.queryId,
      ok: res.ok,
      status: res.status,
      endedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      firstByteMs,
      conversationId: lastMatch(text, /"conversation_id"\s*:\s*"([0-9a-zA-Z-]{8,})"/) || info.conversationId,
      modelSlug:
        lastMatch(text, /"resolved_model_slug"\s*:\s*"([^"]+)"/) ||
        lastMatch(text, /"model_slug"\s*:\s*"([^"]+)"/) ||
        info.model,
      errorSnippet: res.ok ? null : text.slice(0, 400),
    });
  }

  window.fetch = function (input, init) {
    const url = toURL(input);
    const method = methodOf(input, init);
    const p = origFetch.apply(this, arguments);

    try {
      if (url && url.origin === location.origin && BACKEND.test(url.pathname)) {
        const ep = `${method} ${normPath(url.pathname)}`;
        if (!seenEndpoints.has(ep) && seenEndpoints.size < 200) {
          seenEndpoints.add(ep);
          post("seen", { endpoint: ep });
        }
        const auth = headerOf(input, init, "Authorization");
        if (auth && auth !== lastAuth) {
          lastAuth = auth;
          post("auth", { authorization: auth, accountId: headerOf(input, init, "ChatGPT-Account-Id") });
        }

        if (method === "POST" && CONV_POST.test(url.pathname) && init && typeof init.body === "string") {
          const info = parseConversationBody(init.body);
          info.queryId = crypto.randomUUID();
          info.kind = "chat";
          observeConversation(info, p);
        } else if (method === "POST" && CODEX_TASK.test(url.pathname)) {
          const info = { queryId: crypto.randomUUID(), kind: "codex-task", userText: "" };
          try {
            const j = JSON.parse(init && typeof init.body === "string" ? init.body : "{}");
            info.userText = JSON.stringify(j.new_task || j.input_items || j).slice(0, 4000);
          } catch (_) {}
          observeConversation(info, p);
        } else if (method === "GET" && USAGE_GET.test(url.pathname)) {
          p.then((res) => (res.ok ? res.clone().json() : null))
            .then((json) => json && post("usage-raw", { json, ts: Date.now() }))
            .catch(() => {});
        }
      }
    } catch (_) {
      // Never let observation break the page.
    }
    return p;
  };
})();
