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
        const profileName = String(body.profileName || "").trim();
        const password = String(body.password || "").trim();

        if (!profileName || !password) {
          return json({
            success: false,
            error: "Name and password are required"
          }, 400);
        }

        let userNumber = "";
        let exists = true;

        while (exists) {
          userNumber = Math.floor(1000000 + Math.random() * 9000000).toString();

          const found = await env.DB.prepare(
            `SELECT id FROM users WHERE user_number = ?`
          ).bind(userNumber).first();

          exists = !!found;
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO users (id, user_number, profile_name, device_secret, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(id, userNumber, profileName, password, now).run();

        return json({
          success: true,
          userNumber: userNumber,
          message: "Account created successfully"
        });
      } catch (e) {
        return json({
          success: false,
          error: "Register failed: " + String(e.message || e)
        }, 500);
      }
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const body = await request.json();
        const userNumber = String(body.userNumber || "").trim();
        const password = String(body.password || "").trim();

        if (!userNumber || !password) {
          return json({
            success: false,
            error: "User number and password are required"
          }, 400);
        }

        const user = await env.DB.prepare(`
          SELECT id, user_number, profile_name, created_at
          FROM users
          WHERE user_number = ? AND device_secret = ?
        `).bind(userNumber, password).first();

        if (!user) {
          return json({
            success: false,
            error: "Invalid user number or password"
          }, 401);
        }

        return json({
          success: true,
          user: user
        });
      } catch (e) {
        return json({
          success: false,
          error: "Login failed: " + String(e.message || e)
        }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
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
  <title>Private Chat</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #f4f4f4;
      margin: 0;
      padding: 40px 20px;
      color: #111;
    }
    .box {
      max-width: 760px;
      margin: 0 auto;
      background: #fff;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.08);
    }
    .top {
      background: #08142c;
      color: white;
      padding: 18px;
      border-radius: 14px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .top h1 {
      margin: 0;
      font-size: 28px;
    }
    .top p {
      margin: 4px 0 0;
      color: #d4d9e3;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }
    input, button {
      width: 100%;
      padding: 12px;
      margin-bottom: 12px;
      font-size: 15px;
      border-radius: 10px;
      border: 1px solid #ccc;
      box-sizing: border-box;
    }
    button {
      background: #08142c;
      color: white;
      border: none;
      cursor: pointer;
    }
    button:hover {
      opacity: 0.95;
    }
    .status {
      margin-bottom: 16px;
      min-height: 20px;
      font-size: 14px;
      color: #b00020;
    }
    .ok {
      color: #0b7a35;
    }
    .resultBox {
      margin-top: 16px;
      padding: 14px;
      border-radius: 10px;
      background: #eef5ff;
      display: none;
      word-break: break-word;
    }
    @media (max-width: 700px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="box">
    <div class="top">
      <div>
        <h1>Private Chat</h1>
        <p>Simple private messenger</p>
      </div>
      <div>Not logged in</div>
    </div>

    <div id="status" class="status"></div>

    <div class="grid">
      <div>
        <h2>Create Account</h2>
        <input id="registerName" placeholder="Profile name" />
        <input id="registerPassword" type="password" placeholder="Password" />
        <button onclick="registerUser()">Create Account</button>
      </div>

      <div>
        <h2>Login</h2>
        <input id="loginNumber" placeholder="User number" />
        <input id="loginPassword" type="password" placeholder="Password" />
        <button onclick="loginUser()">Login</button>
      </div>
    </div>

    <div id="resultBox" class="resultBox"></div>
  </div>

  <script>
    function setStatus(text, ok) {
      const status = document.getElementById("status");
      status.textContent = text || "";
      status.className = ok ? "status ok" : "status";
    }

    function showResult(text) {
      const box = document.getElementById("resultBox");
      box.style.display = "block";
      box.textContent = text;
    }

    async function registerUser() {
      try {
        setStatus("");
        document.getElementById("resultBox").style.display = "none";

        const profileName = document.getElementById("registerName").value.trim();
        const password = document.getElementById("registerPassword").value.trim();

        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            profileName: profileName,
            password: password
          })
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
          setStatus(data.error || "Register failed");
          return;
        }

        setStatus("Account created successfully", true);
        showResult("Your user number is: " + data.userNumber + ". Save it now.");
      } catch (err) {
        setStatus("Register failed");
      }
    }

    async function loginUser() {
      try {
        setStatus("");
        document.getElementById("resultBox").style.display = "none";

        const userNumber = document.getElementById("loginNumber").value.trim();
        const password = document.getElementById("loginPassword").value.trim();

        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userNumber: userNumber,
            password: password
          })
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
          setStatus(data.error || "Login failed");
          return;
        }

        setStatus("Login successful", true);
        showResult(
          "Welcome " + data.user.profile_name +
          " | User number: " + data.user.user_number
        );
      } catch (err) {
        setStatus("Login failed");
      }
    }
  </script>
</body>
</html>`;
}
