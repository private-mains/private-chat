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
        const { email, password } = await request.json();

        if (!email || !password) {
          return json({ error: "Email and password are required" }, 400);
        }

        const cleanEmail = String(email).trim().toLowerCase();
        const cleanPassword = String(password);

        const existingUser = await env.DB.prepare(
          `SELECT id FROM users WHERE email = ?`
        ).bind(cleanEmail).first();

        if (existingUser) {
          return json({ error: "User already exists" }, 409);
        }

        const id = crypto.randomUUID();
        const created = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES (?, ?, ?, ?)
        `).bind(id, cleanEmail, cleanPassword, created).run();

        return json({ success: true, message: "Registered" });
      } catch (error) {
        return json({ error: "Register failed" }, 500);
      }
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const { email, password } = await request.json();

        if (!email || !password) {
          return json({ error: "Email and password are required" }, 400);
        }

        const cleanEmail = String(email).trim().toLowerCase();
        const cleanPassword = String(password);

        const user = await env.DB.prepare(`
          SELECT * FROM users WHERE email = ?
        `).bind(cleanEmail).first();

        if (!user) {
          return json({ error: "User not found" }, 401);
        }

        if (user.password_hash !== cleanPassword) {
          return json({ error: "Wrong password" }, 401);
        }

        return json({
          success: true,
          userId: user.id,
          email: user.email
        });
      } catch (error) {
        return json({ error: "Login failed" }, 500);
      }
    }

    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const { userId, message } = await request.json();

        if (!userId || !message) {
          return json({ error: "Missing userId or message" }, 400);
        }

        const id = crypto.randomUUID();
        const created = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO messages (id, user_id, body, created_at)
          VALUES (?, ?, ?, ?)
        `).bind(id, userId, String(message).trim(), created).run();

        return json({ success: true });
      } catch (error) {
        return json({ error: "Send failed" }, 500);
      }
    }

    if (url.pathname === "/api/messages" && request.method === "GET") {
      try {
        const rows = await env.DB.prepare(`
          SELECT * FROM messages ORDER BY created_at DESC LIMIT 50
        `).all();

        return json(rows.results || []);
      } catch (error) {
        return json({ error: "Could not load messages" }, 500);
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
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Private Chat V2</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      padding: 24px;
      margin: 0;
      background: #f5f5f5;
    }
    .card {
      max-width: 420px;
      background: white;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.08);
    }
    input, textarea, button {
      width: 100%;
      box-sizing: border-box;
      padding: 10px;
      margin-top: 10px;
      font-size: 14px;
    }
    .row {
      display: flex;
      gap: 10px;
      margin-top: 10px;
    }
    .row button {
      width: auto;
      flex: 1;
      cursor: pointer;
    }
    #chat {
      display: none;
      margin-top: 20px;
    }
    #messages {
      margin-top: 15px;
      background: #fafafa;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 12px;
      max-height: 300px;
      overflow-y: auto;
    }
    .msg {
      padding: 8px 10px;
      margin-bottom: 8px;
      background: #e9f2ff;
      border-radius: 8px;
    }
    .small {
      color: #666;
      font-size: 12px;
      margin-top: 6px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h2>Private Chat V2</h2>
    <div class="small">Login fix test</div>

    <input id="email" type="email" placeholder="Email" />
    <input id="password" type="password" placeholder="Password" />

    <div class="row">
      <button onclick="registerUser()">Register</button>
      <button onclick="loginUser()">Login</button>
    </div>

    <div id="chat">
      <hr />
      <div class="small" id="welcome"></div>
      <textarea id="msg" placeholder="Type message"></textarea>
      <button onclick="sendMessage()">Send</button>
      <div id="messages"></div>
    </div>
  </div>

  <script>
    let userId = null;

    async function registerUser() {
      try {
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

        if (data.error) {
          alert(data.error);
          return;
        }

        alert("Registered successfully");
      } catch (err) {
        console.error("REGISTER ERROR:", err);
        alert("Register request failed");
      }
    }

    async function loginUser() {
      try {
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
        console.log("LOGIN RESPONSE:", data);

        if (data.error) {
          alert(data.error);
          return;
        }

        if (data.userId) {
          userId = data.userId;
          document.getElementById("chat").style.display = "block";
          document.getElementById("welcome").textContent = "Logged in as: " + data.email;
          alert("Login successful");
          await loadMessages();
        } else {
          alert("Login failed");
        }
      } catch (err) {
        console.error("LOGIN ERROR:", err);
        alert("Login request failed");
      }
    }

    async function sendMessage() {
      try {
        const message = document.getElementById("msg").value.trim();

        if (!userId) {
          alert("Please login first");
          return;
        }

        if (!message) {
          alert("Type a message");
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

        if (data.error) {
          alert(data.error);
          return;
        }

        document.getElementById("msg").value = "";
        await loadMessages();
      } catch (err) {
        console.error("SEND ERROR:", err);
        alert("Send request failed");
      }
    }

    async function loadMessages() {
      try {
        const res = await fetch("/api/messages");
        const data = await res.json();

        if (!Array.isArray(data)) {
          alert(data.error || "Could not load messages");
          return;
        }

        const messagesBox = document.getElementById("messages");
        messagesBox.innerHTML = data.map(function(m) {
          return '<div class="msg">' + escapeHtml(m.body || "") + '</div>';
        }).join("");
      } catch (err) {
        console.error("LOAD ERROR:", err);
        alert("Loading messages failed");
      }
    }

    function escapeHtml(str) {
      return str
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }
  </script>
</body>
</html>
`;
}
