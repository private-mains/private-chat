export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(htmlPage(), {
        headers: { "content-type": "text/html" }
      });
    }

    if (url.pathname === "/api/register" && request.method === "POST") {
      const { email, password } = await request.json();

      if (!email || !password) {
        return json({ error: "Missing fields" }, 400);
      }

      const id = crypto.randomUUID();
      const created = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO users (id, email, password_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(id, email, password, created).run();

      return json({ success: true });
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      const { email, password } = await request.json();

      const user = await env.DB.prepare(`
        SELECT * FROM users WHERE email = ?
      `).bind(email).first();

      if (!user || user.password_hash !== password) {
        return json({ error: "Invalid login" }, 401);
      }

      return json({ success: true, userId: user.id });
    }

    if (url.pathname === "/api/send" && request.method === "POST") {
      const { userId, message } = await request.json();

      const id = crypto.randomUUID();
      const created = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO messages (id, user_id, body, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(id, userId, message, created).run();

      return json({ success: true });
    }

    if (url.pathname === "/api/messages") {
      const rows = await env.DB.prepare(`
        SELECT * FROM messages ORDER BY created_at DESC LIMIT 50
      `).all();

      return json(rows.results);
    }

    return new Response("Not Found", { status: 404 });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function htmlPage() {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Private Chat</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
</head>
<body style="font-family:sans-serif; padding:20px;">

<h2>Private Chat</h2>

<input id="email" placeholder="Email"/><br/><br/>
<input id="password" placeholder="Password" type="password"/><br/><br/>

<button onclick="register()">Register</button>
<button onclick="login()">Login</button>

<hr/>

<div id="chat" style="display:none;">
  <textarea id="msg" placeholder="Type message"></textarea><br/>
  <button onclick="send()">Send</button>
  <div id="messages"></div>
</div>

<script>
let userId = null;

async function register() {
  await fetch('/api/register', {
    method:'POST',
    body:JSON.stringify({
      email:email.value,
      password:password.value
    })
  });
  alert('Registered');
}

async function login() {
  const res = await fetch('/api/login',{
    method:'POST',
    body:JSON.stringify({
      email:email.value,
      password:password.value
    })
  });
  const data = await res.json();

  if(data.userId){
    userId = data.userId;
    chat.style.display='block';
    load();
  }
}

async function send(){
  await fetch('/api/send',{
    method:'POST',
    body:JSON.stringify({
      userId,
      message:msg.value
    })
  });
  msg.value='';
  load();
}

async function load(){
  const res = await fetch('/api/messages');
  const data = await res.json();

  messages.innerHTML = data.map(m=>"<p>"+m.body+"</p>").join("");
}
</script>

</body>
</html>
`;
}
