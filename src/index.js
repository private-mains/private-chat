export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(htmlPage(), {
        headers: { "content-type": "text/html; charset=UTF-8" }
      });
    }

    if (url.pathname === "/api/register" && request.method === "POST") {
      try {
        const body = await request.json();
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");

        if (!email || !password) {
          return json({ error: "Email and password are required" }, 400);
        }

        const existingUser = await env.DB.prepare(
          `SELECT id FROM users WHERE email = ?`
        ).bind(email).first();

        if (existingUser) {
          return json({ error: "User already exists" }, 409);
        }

        const id = crypto.randomUUID();
        const created = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES (?, ?, ?, ?)
        `).bind(id, email, password, created).run();

        return json({ success: true, message: "Registered successfully" });
      } catch (error) {
        return json({
          error: "Register failed",
          details: String(error && error.message ? error.message : error)
        }, 500);
      }
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const body = await request.json();
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");

        if (!email || !password) {
          return json({ error: "Email and password are required" }, 400);
        }

        const user = await env.DB.prepare(`
          SELECT id, email, password_hash
          FROM users
          WHERE email = ?
        `).bind(email).first();

        if (!user) {
          return json({ error: "User not found" }, 401);
        }

        if (user.password_hash !== password) {
          return json({ error: "Wrong password" }, 401);
        }

        return json({
          success: true,
          userId: user.id,
          email: user.email
        });
      } catch (error) {
        return json({
          error: "Login failed",
          details: String(error && error.message ? error.message : error)
        }, 500);
      }
    }

    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await request.json();
        const userId = String(body.userId || "").trim();
        const message = String(body.message || "").trim();

        if (!userId || !message) {
          return json({ error: "Missing userId or message" }, 400);
        }

        const user = await env.DB.prepare(
          `SELECT id FROM users WHERE id = ?`
        ).bind(userId).first();

        if (!user) {
          return json({ error: "Invalid user" }, 401);
        }

        const id = crypto.randomUUID();
        const created = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO messages (id, user_id, body, created_at)
          VALUES (?, ?, ?, ?)
        `).bind(id, userId, message, created).run();

        return json({ success: true });
      } catch (error) {
        return json({
          error: "Send failed",
          details: String(error && error.message ? error.message : error)
        }, 500);
      }
    }

    if (url.pathname === "/api/messages" && request.method === "GET") {
      try {
        const rows = await env.DB.prepare(`
          SELECT messages.id, messages.body, messages.created_at, users.email
          FROM messages
          LEFT JOIN users ON users.id = messages.user_id
          ORDER BY messages.created_at DESC
          LIMIT 50
        `).all();

        return json(rows.results || []);
      } catch (error) {
        return json({
          error: "Could not load messages",
          details: String(error && error.message ? error.message : error)
        }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8"
    }
  });
}

function htmlPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Private Chat V3</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: Arial, sans-serif;
      background: #f3f4f6;
      color: #111827;
    }
    .wrap {
      max-width: 520px;
      margin: 0 auto;
    }
    .card {
      background: #fff;
      border-radius: 14px;
      padding: 20px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.08);
    }
    h2 {
      margin: 0 0 8px;
      font-size: 28px;
    }
    .sub {
      color: #6b7280;
      font-size: 13px;
      margin-bottom: 16px;
    }
    input, textarea, button {
      width: 100%;
      padding: 12px;
      border-radius: 10px;
      border: 1px solid #d1d5db;
      font-size: 14px;
    }
    input, textarea {
      background: #fff;
      margin-bottom: 10px;
    }
    button {
      border: none;
      background: #111827;
      color: white;
      cursor: pointer;
    }
    button:hover {
      opacity: 0.92;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 10px;
    }
    #chat {
      display: none;
      margin-top: 18px;
    }
    #welcome {
      font-size: 13px;
      color: #374151;
      margin-bottom: 10px;
    }
    #messages {
      margin-top: 12px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 12px;
      max-height: 320px;
      overflow-y: auto;
    }
    .msg {
      background: #e5edff;
      border-radius: 10px;
      padding: 10px;
      margin-bottom: 10px;
    }
    .meta {
      font-size: 12px;
      color: #6b7280;
      margin-bottom: 4px;
    }
    .error {
      margin-top: 10px;
      color: #b91c1c;
      font-size: 13px;
      min-height: 18px;
    }
    .ok {
      color: #047857;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h2>Private Chat V3</h2>
      <div class="sub">Working starter build</div>

      <input id="email" type="email" placeholder="Email" />
      <input id="password" type="password" placeholder="Password" />

      <div class="row">
        <button onclick="registerUser()">Register</button>
        <button onclick="loginUser()">Login</button>
      </div>

      <div id="status" class="error"></div>

      <div id="chat">
        <hr />
        <div id="welcome"></div>
        <textarea id="msg" rows="4" placeholder="Type message"></textarea>
        <button onclick="sendMessage()">Send Message</button>
        <div id="messages"></div>
      </div>
    </div>
  </div>

  <script>
    let userId = null;

    function setStatus(text, ok = false) {
      const el = document.getElementById("status");
      el.textContent = text || "";
      el.className = ok ? "error ok" : "error";
    }

    async function registerUser() {
      try {
        setStatus("");

        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;

        const res = await fetch("/api/register", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ email, password })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus(data.error || "Register failed");
          return;
        }

        setStatus(data.message || "Registered successfully", true);
      } catch (err) {
        console.error(err);
        setStatus("Register request failed");
      }
    }

    async function loginUser() {
      try {
        setStatus("");

        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;

        const res = await fetch("/api/login", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ email, password })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus(data.error || "Login failed");
          return;
        }

        userId = data.userId;
        document.getElementById("chat").style.display = "block";
        document.getElementById("welcome").textContent = "Logged in as: " + data.email;
        setStatus("Login successful", true);
        await loadMessages();
      } catch (err) {
        console.error(err);
        setStatus("Login request failed");
      }
    }

    async function sendMessage() {
      try {
        setStatus("");

        const message = document.getElementById("msg").value.trim();

        if (!userId) {
          setStatus("Please login first");
          return;
        }

        if (!message) {
          setStatus("Type a message");
          return;
        }

        const res = await fetch("/api/send", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            userId,
            message
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus(data.error || "Send failed");
          return;
        }

        document.getElementById("msg").value = "";
        setStatus("Message sent", true);
        await loadMessages();
      } catch (err) {
        console.error(err);
        setStatus("Send request failed");
      }
    }

    async function loadMessages() {
      try {
        const res = await fetch("/api/messages");
        const data = await res.json();

        if (!res.ok || !Array.isArray(data)) {
          setStatus((data && data.error) || "Could not load messages");
          return;
        }

        const box = document.getElementById("messages");

        box.innerHTML = data.map((m) => {
          const email = escapeHtml(m.email || "Unknown user");
          const body = escapeHtml(m.body || "");
          const created = escapeHtml(m.created_at || "");
          return \`
            <div class="msg">
              <div class="meta">\${email} • \${created}</div>
              <div>\${body}</div>
            </div>
          \`;
        }).join("");
      } catch (err) {
        console.error(err);
        setStatus("Loading messages failed");
      }
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }
  </script>
</body>
</html>`;
}
