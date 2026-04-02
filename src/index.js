export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/register" && request.method === "POST") {
      const { name, password } = await request.json();

      const userNumber = Math.floor(1000000 + Math.random() * 9000000).toString();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO users (id, user_number, profile_name, device_secret, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(id, userNumber, name, password, now).run();

      return Response.json({ success: true, userNumber });
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      const { userNumber, password } = await request.json();

      const user = await env.DB.prepare(`
        SELECT * FROM users WHERE user_number = ? AND device_secret = ?
      `).bind(userNumber, password).first();

      if (!user) {
        return Response.json({ success: false });
      }

      return Response.json({ success: true, user });
    }

    return new Response("API running");
  }
};
