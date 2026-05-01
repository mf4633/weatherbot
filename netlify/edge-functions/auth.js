// HTTP Basic Auth gate. Username is arbitrary, password is "hydro".
// Edge function runs on every request to the site (config below).
// Scheduled functions (logger.js) bypass the edge — they run via cron, not HTTP.

const PASSWORD = "hydro";
const REALM = "weatherbot";

export default async (request, context) => {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const idx = decoded.indexOf(":");
      const password = idx >= 0 ? decoded.slice(idx + 1) : decoded;
      if (password === PASSWORD) return context.next();
    } catch (e) { /* fall through to 401 */ }
  }
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      "content-type": "text/plain"
    }
  });
};

export const config = { path: "/*" };
