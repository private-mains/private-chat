export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return htmlResponse(renderApp());
    }

    if (url.pathname === "/api/register" && request.method === "POST") {
      try {
        const body = await request.json();
        const profileName = String(body.profileName || "").trim();
        const password = String(body.password || "");
        const profilePictureUrl = String(body.profilePictureUrl || "").trim();

        if (!profileName || !password) {
          return json({ error: "Profile name and password are required" }, 400);
        }

        const userNumber = await generateUserNumber(env.DB);
        const userId = crypto.randomUUID();
        const createdAt = nowIso();

        await env.DB.prepare(`
          INSERT INTO users (id, user_number, profile_name, password_hash, profile_picture_url, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          userId,
          userNumber,
          profileName,
          password,
          profilePictureUrl || null,
          createdAt
        ).run();

        return json({
          success: true,
          user: {
            id: userId,
            userNumber,
            profileName,
            profilePictureUrl: profilePictureUrl || ""
          }
        });
      } catch (error) {
        return json({ error: "Register failed: " + errMsg(error) }, 500);
      }
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const body = await request.json();
        const userNumber = String(body.userNumber || "").trim();
        const password = String(body.password || "");

        if (!userNumber || !password) {
          return json({ error: "User number and password are required" }, 400);
        }

        const user = await env.DB.prepare(`
          SELECT id, user_number, profile_name, password_hash, profile_picture_url
          FROM users
          WHERE user_number = ?
        `).bind(userNumber).first();

        if (!user) {
          return json({ error: "User not found" }, 404);
        }

        if (user.password_hash !== password) {
          return json({ error: "Wrong password" }, 401);
        }

        return json({
          success: true,
          user: {
            id: user.id,
            userNumber: user.user_number,
            profileName: user.profile_name,
            profilePictureUrl: user.profile_picture_url || ""
          }
        });
      } catch (error) {
        return json({ error: "Login failed: " + errMsg(error) }, 500);
      }
    }

    if (url.pathname === "/api/user-by-number" && request.method === "GET") {
      try {
        const userNumber = String(url.searchParams.get("userNumber") || "").trim();
        const requesterId = String(url.searchParams.get("requesterId") || "").trim();

        if (!userNumber || !requesterId) {
          return json({ error: "Missing user number or requester" }, 400);
        }

        const user = await env.DB.prepare(`
          SELECT id, user_number, profile_name, profile_picture_url
          FROM users
          WHERE user_number = ?
        `).bind(userNumber).first();

        if (!user) {
          return json({ error: "User not found" }, 404);
        }

        if (user.id === requesterId) {
          return json({ error: "You cannot chat with yourself" }, 400);
        }

        return json({
          success: true,
          user: {
            id: user.id,
            userNumber: user.user_number,
            profileName: user.profile_name,
            profilePictureUrl: user.profile_picture_url || ""
          }
        });
      } catch (error) {
        return json({ error: "Search failed: " + errMsg(error) }, 500);
      }
    }

    if (url.pathname === "/api/start-chat" && request.method === "POST") {
      try {
        const body = await request.json();
        const currentUserId = String(body.currentUserId || "").trim();
        const targetUserNumber = String(body.targetUserNumber || "").trim();

        if (!currentUserId || !targetUserNumber) {
          return json({ error: "Missing user data" }, 400);
        }

        const currentUser = await getUserById(env.DB, currentUserId);
        if (!currentUser) {
          return json({ error: "Current user not found" }, 404);
        }

        const targetUser = await env.DB.prepare(`
          SELECT id, user_number, profile_name, profile_picture_url
          FROM users
          WHERE user_number = ?
        `).bind(targetUserNumber).first();

        if (!targetUser) {
          return json({ error: "Target user not found" }, 404);
        }

        if (targetUser.id === currentUserId) {
          return json({ error: "You cannot start chat with yourself" }, 400);
        }

        const ordered = [currentUserId, targetUser.id].sort();
        const userA = ordered[0];
        const userB = ordered[1];

        let conversation = await env.DB.prepare(`
          SELECT id
          FROM conversations
          WHERE user_a_id = ? AND user_b_id = ?
        `).bind(userA, userB).first();

        if (!conversation) {
          const conversationId = crypto.randomUUID();
          const timestamp = nowIso();

          await env.DB.prepare(`
            INSERT INTO conversations (id, user_a_id, user_b_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(conversationId, userA, userB, timestamp, timestamp).run();

          conversation = { id: conversationId };
        }

        await env.DB.prepare(`
          DELETE FROM hidden_conversations
          WHERE conversation_id = ? AND user_id IN (?, ?)
        `).bind(conversation.id, currentUserId, targetUser.id).run();

        return json({
          success: true,
          conversationId: conversation.id,
          targetUser: {
            id: targetUser.id,
            userNumber: targetUser.user_number,
            profileName: targetUser.profile_name,
            profilePictureUrl: targetUser.profile_picture_url || ""
          }
        });
      } catch (error) {
        return json({ error: "Start chat failed: " + errMsg(error) }, 500);
      }
    }

    if (url.pathname === "/api/conversations" && request.method === "GET") {
      try {
        const currentUserId = String(url.searchParams.get("currentUserId") || "").trim();
        if (!currentUserId) {
          return json({ error: "Missing current user" }, 400);
        }

        const conversations = await env.DB.prepare(`
          SELECT
            c.id,
            c.updated_at,
            u.id AS other_user_id,
            u.user_number AS other_user_number,
            u.profile_name AS other_profile_name,
            u.profile_picture_url AS other_profile_picture_url,
            (
              SELECT m.body
              FROM messages m
              WHERE m.conversation_id = c.id AND m.is_deleted = 0
              ORDER BY m.created_at DESC
              LIMIT 1
            ) AS last_message
          FROM conversations c
          JOIN users u
            ON u.id = CASE
              WHEN c.user_a_id = ? THEN c.user_b_id
              ELSE c.user_a_id
            END
          LEFT JOIN hidden_conversations hc
            ON hc.conversation_id = c.id AND hc.user_id = ?
          WHERE (c.user_a_id = ? OR c.user_b_id = ?)
            AND hc.id IS NULL
          ORDER BY c.updated_at DESC
        `).bind(currentUserId, currentUserId, currentUserId, currentUserId).all();

        return json({ success: true, conversations: conversations.results || [] });
      } catch (error) {
        return json({ error: "Load conversations failed: " + errMsg(error) }, 500);
      }
    }

    if (url.pathname === "/api/messages" && request.method === "GET") {
      try {
        const conversationId = String(url.searchParams.get("conversationId") || "").trim();
        const currentUserId = String(url.searchParams.get("currentUserId") || "").trim();

        if (!conversationId || !currentUserId) {
          return json({ error: "Missing conversation or user" }, 400);
        }

        const allowed = await canAccessConversation(env.DB, currentUserId, conversationId);
        if (!allowed) {
          return json({ error: "Access denied" }, 403);
        }

        const rows = await env.DB.prepare(`
          SELECT
            m.id,
            m.body,
            m.created_at,
            m.updated_at,
            m.sender_id,
            u.profile_name,
            u.user_number
          FROM messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id = ? AND m.is_deleted = 0
          ORDER BY m.created_at ASC
        `).bind(conversationId).all();

        return json({ success: true, messages: rows.results || [] });
      } catch (error) {
        return json({ error: "Load messages failed: " + errMsg(error) }, 500);
      }
    }

    if (url.pathname === "/api/send-message" && request.method === "POST") {
      try {
        const body = await request.json();
        const conversationId = String(body.conversationId || "").trim();
        const senderId = String(body.senderId || "").trim();
        const message = String(body.message || "").trim();

        if (!conversationId || !senderId || !message) {
          return json({ error: "Missing message data" }, 400);
        }

        const allowed = await canAccessConversation(env.DB, senderId, conversationId);
        if (!allowed) {
          return json({ error: "Access denied" }, 403);
        }

        const messageId = crypto.randomUUID();
        const timestamp = nowIso();

        await env.DB.prepare(`
          INSERT INTO messages (id, conversation_id, sender_id, body, created_at, updated_at, is_deleted)
          VALUES (?, ?, ?, ?, ?, ?, 0)
        `).bind(messageId, conversationId, senderId, message, timestamp, timestamp).run();

        await env.DB.prepare(`
          UPDATE conversations
          SET updated_at = ?
          WHERE id = ?
        `).bind(timestamp, conversationId).run();

        return json({ success: true });
      } catch (error) {
        return json({ error: "Send message failed: " + errMsg(error) }, 500);
      }
    }

    if (url.pathname === "/api/edit-message" && request.method === "POST") {
      try {
        const body = await request.json();
        const messageId = String(body.messageId || "").trim();
        const currentUserId = String(body.currentUserId || "").trim();
        const message = String(body.message || "").trim();

        if (!messageId || !currentUserId || !message) {
          return json({ error: "Missing edit data" }, 400);
        }

        const row = await env.DB.prepare(`
          SELECT id, conversation_id, sender_id
          FROM messages
          WHERE id = ? AND is_deleted = 0
        `).bind(messageId).first();

        if (!row) {
          return json({ error: "Message not found" }, 404);
        }

        if (row.sender_id !== currentUserId) {
          return json({ error: "You can only edit your own message" }, 403);
        }

        const timestamp = nowIso();

        await env.DB.prepare(`
          UPDATE messages
          SET body = ?, updated_at = ?
          WHERE id = ?
        `).bind(message, timestamp, messageId).run();

        await env.DB.prepare(`
          UPDATE conversations
          SET updated_at = ?
          WHERE id = ?
        `).bind(timestamp, row.conversation_id).run();

        return json({ success: true });
      } catch (error) {
        return json({ error: "Edit message failed: " + errMsg(error) }, 500);
      }
    }

    if (url.pathname === "/api/delete-message" && request.method === "POST") {
      try {
        const body = await request.json();
        const messageId = String(body.messageId || "").trim();
        const currentUserId = String(body.currentUserId || "").trim();

        if (!messageId || !currentUserId) {
          return json({ error: "Missing delete data" }, 400);
        }

        const row = await env.DB.prepare(`
          SELECT id, conversation_id, sender_id
          FROM messages
          WHERE id = ? AND is_deleted = 0
        `).bind(messageId).first();

        if (!row) {
          return json({ error: "Message not found" }, 404);
        }

        if (row.sender_id !== currentUserId) {
          return json({ error: "You can only delete your own message" }, 403);
        }

        const timestamp = nowIso();

        await env.DB.prepare(`
          UPDATE messages
          SET is_deleted = 1, updated_at = ?
          WHERE id = ?
        `).bind(timestamp, messageId).run();

        await env.DB.prepare(`
          UPDATE conversations
          SET updated_at = ?
          WHERE id = ?
        `).bind(timestamp, row.conversation_id).run();

        return json({ success: true });
      } catch (error) {
        return json({ error: "Delete message failed: " + errMsg(error) }, 500);
      }
    }

    if (url.pathname === "/api/hide-conversation" && request.method === "POST") {
      try {
        const body = await request.json();
        const conversationId = String(body.conversationId || "").trim();
        const currentUserId = String(body.currentUserId || "").trim();

        if (!conversationId || !currentUserId) {
          return json({ error: "Missing conversation data" }, 400);
        }

        const allowed = await canAccessConversation(env.DB, currentUserId, conversationId);
        if (!allowed) {
          return json({ error: "Access denied" }, 403);
        }

        await env.DB.prepare(`
          INSERT OR REPLACE INTO hidden_conversations (id, conversation_id, user_id, hidden_at)
          VALUES (?, ?, ?, ?)
        `).bind(crypto.randomUUID(), conversationId, currentUserId, nowIso()).run();

        return json({ success: true });
      } catch (error) {
        return json({ error: "Hide conversation failed: " + errMsg(error) }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

function htmlResponse(html) {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=UTF-8" }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" }
  });
}

function nowIso() {
  return new Date().toISOString();
}

function errMsg(error) {
  return String(error && error.message ? error.message : error);
}

async function getUserById(db, userId) {
  return await db.prepare(`
    SELECT id, user_number, profile_name, profile_picture_url
    FROM users
    WHERE id = ?
  `).bind(userId).first();
}

async function canAccessConversation(db, userId, conversationId) {
  const row = await db.prepare(`
    SELECT id
    FROM conversations
    WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)
  `).bind(conversationId, userId, userId).first();

  return !!row;
}

async function generateUserNumber(db) {
  while (true) {
    const number = String(Math.floor(100000000 + Math.random() * 900000000));
    const exists = await db.prepare(`
      SELECT id FROM users WHERE user_number = ?
    `).bind(number).first();

    if (!exists) {
      return number;
    }
  }
}

function renderApp() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Private Chat</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #f4f6f8;
      color: #111827;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 18px;
    }
    .topbar {
      background: #111827;
      color: white;
      padding: 16px 18px;
      border-radius: 16px;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .brand {
      font-size: 22px;
      font-weight: 700;
    }
    .sub {
      font-size: 12px;
      color: #d1d5db;
    }
    .layout {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 16px;
    }
    .panel {
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.06);
      padding: 16px;
    }
    .hidden { display: none !important; }
    h2, h3 {
      margin-top: 0;
    }
    input, textarea, button {
      width: 100%;
      padding: 12px;
      border-radius: 10px;
      border: 1px solid #d1d5db;
      font-size: 14px;
      margin-bottom: 10px;
    }
    textarea {
      resize: vertical;
      min-height: 70px;
    }
    button {
      border: none;
      cursor: pointer;
      background: #111827;
      color: #fff;
    }
    button.secondary {
      background: #e5e7eb;
      color: #111827;
    }
    button.danger {
      background: #b91c1c;
      color: white;
    }
    .two {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .status {
      min-height: 18px;
      font-size: 13px;
      margin: 8px 0 12px;
      color: #b91c1c;
    }
    .ok {
      color: #047857;
    }
    .user-badge {
      background: #f3f4f6;
      border-radius: 12px;
      padding: 12px;
      margin-bottom: 14px;
    }
    .avatar {
      width: 42px;
      height: 42px;
      border-radius: 50%;
      object-fit: cover;
      background: #d1d5db;
    }
    .user-row {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .muted {
      color: #6b7280;
      font-size: 12px;
    }
    .conversation-item {
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 10px;
      margin-bottom: 10px;
      cursor: pointer;
      background: #fafafa;
    }
    .conversation-item:hover {
      background: #f3f4f6;
    }
    .chat-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .messages {
      height: 420px;
      overflow-y: auto;
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      padding: 12px;
      background: #f9fafb;
      margin-bottom: 12px;
    }
    .message {
      max-width: 80%;
      padding: 10px 12px;
      border-radius: 14px;
      margin-bottom: 12px;
      word-break: break-word;
    }
    .mine {
      margin-left: auto;
      background: #dbeafe;
    }
    .theirs {
      margin-right: auto;
      background: #e5e7eb;
    }
    .message-meta {
      font-size: 11px;
      color: #6b7280;
      margin-bottom: 4px;
    }
    .message-actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .message-actions button {
      width: auto;
      margin: 0;
      padding: 6px 10px;
      font-size: 12px;
    }
    .empty {
      color: #6b7280;
      padding: 20px 0;
      text-align: center;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .messages {
        height: 320px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="topbar">
      <div>
        <div class="brand">Private Chat</div>
        <div class="sub">Simple private messenger</div>
      </div>
      <div id="topUserInfo" class="sub">Not logged in</div>
    </div>

    <div id="authPanel" class="panel">
      <h2>Create account or login</h2>
      <div class="status" id="authStatus"></div>

      <div class="two">
        <div>
          <h3>Create Account</h3>
          <input id="registerProfileName" placeholder="Profile name" />
          <input id="registerProfilePictureUrl" placeholder="Profile picture URL (optional)" />
          <input id="registerPassword" type="password" placeholder="Password" />
          <button onclick="registerUser()">Create Account</button>
        </div>

        <div>
          <h3>Login</h3>
          <input id="loginUserNumber" placeholder="User number" />
          <input id="loginPassword" type="password" placeholder="Password" />
          <button onclick="loginUser()">Login</button>
        </div>
      </div>
    </div>

    <div id="appPanel" class="layout hidden">
      <div class="panel">
        <div class="user-badge">
          <div class="user-row">
            <img id="myAvatar" class="avatar" alt="avatar" />
            <div>
              <div id="myProfileName"><strong></strong></div>
              <div class="muted">User number: <span id="myUserNumber"></span></div>
            </div>
          </div>
        </div>

        <div class="status" id="leftStatus"></div>

        <h3>Start Chat</h3>
        <input id="startChatUserNumber" placeholder="Enter user number" />
        <button onclick="startChat()">Start chat</button>

        <h3>Your Chats</h3>
        <div id="conversationList"></div>

        <button class="secondary" onclick="logoutUser()">Logout</button>
      </div>

      <div class="panel">
        <div id="chatEmptyState" class="empty">
          Select a chat or start a new one.
        </div>

        <div id="chatPanel" class="hidden">
          <div class="chat-header">
            <div class="user-row">
              <img id="chatAvatar" class="avatar" alt="chat avatar" />
              <div>
                <div id="chatName"><strong></strong></div>
                <div class="muted">User number: <span id="chatUserNumber"></span></div>
              </div>
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <button class="secondary" onclick="hideConversation()">Hide chat</button>
            </div>
          </div>

          <div class="status" id="chatStatus"></div>

          <div id="messagesBox" class="messages"></div>

          <textarea id="messageInput" placeholder="Type your message"></textarea>
          <button onclick="sendMessage()">Send Message</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentUser = null;
    let currentConversationId = null;
    let currentChatTarget = null;

    function setStatus(id, text, ok = false) {
      const el = document.getElementById(id);
      el.textContent = text || "";
      el.className = ok ? "status ok" : "status";
    }

    function escapeHtml(str) {
      return String(str || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function avatarValue(url) {
      return url && url.trim() ? url.trim() : "https://via.placeholder.com/64?text=U";
    }

    function saveSession() {
      if (currentUser) {
        localStorage.setItem("privateChatUser", JSON.stringify(currentUser));
      } else {
        localStorage.removeItem("privateChatUser");
      }
    }

    function loadSession() {
      try {
        const raw = localStorage.getItem("privateChatUser");
        if (!raw) return;
        currentUser = JSON.parse(raw);
        showApp();
      } catch (_) {}
    }

    function showApp() {
      document.getElementById("authPanel").classList.add("hidden");
      document.getElementById("appPanel").classList.remove("hidden");

      document.getElementById("myProfileName").innerHTML = "<strong>" + escapeHtml(currentUser.profileName) + "</strong>";
      document.getElementById("myUserNumber").textContent = currentUser.userNumber;
      document.getElementById("myAvatar").src = avatarValue(currentUser.profilePictureUrl);
      document.getElementById("topUserInfo").textContent = currentUser.profileName + " • " + currentUser.userNumber;

      loadConversations();
    }

    function logoutUser() {
      currentUser = null;
      currentConversationId = null;
      currentChatTarget = null;
      saveSession();
      location.reload();
    }

    async function registerUser() {
      try {
        setStatus("authStatus", "");

        const profileName = document.getElementById("registerProfileName").value.trim();
        const profilePictureUrl = document.getElementById("registerProfilePictureUrl").value.trim();
        const password = document.getElementById("registerPassword").value;

        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profileName, profilePictureUrl, password })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("authStatus", data.error || "Register failed");
          return;
        }

        currentUser = data.user;
        saveSession();
        setStatus("authStatus", "Account created. Your user number is " + data.user.userNumber, true);
        showApp();
      } catch (err) {
        setStatus("authStatus", "Register request failed");
      }
    }

    async function loginUser() {
      try {
        setStatus("authStatus", "");

        const userNumber = document.getElementById("loginUserNumber").value.trim();
        const password = document.getElementById("loginPassword").value;

        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userNumber, password })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("authStatus", data.error || "Login failed");
          return;
        }

        currentUser = data.user;
        saveSession();
        setStatus("authStatus", "Login successful", true);
        showApp();
      } catch (err) {
        setStatus("authStatus", "Login request failed");
      }
    }

    async function startChat() {
      try {
        setStatus("leftStatus", "");

        const targetUserNumber = document.getElementById("startChatUserNumber").value.trim();
        if (!targetUserNumber) {
          setStatus("leftStatus", "Enter a user number");
          return;
        }

        const res = await fetch("/api/start-chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            currentUserId: currentUser.id,
            targetUserNumber
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("leftStatus", data.error || "Could not start chat");
          return;
        }

        currentConversationId = data.conversationId;
        currentChatTarget = data.targetUser;
        setStatus("leftStatus", "Chat opened", true);
        document.getElementById("startChatUserNumber").value = "";
        await loadConversations();
        await openChat(currentConversationId, currentChatTarget);
      } catch (err) {
        setStatus("leftStatus", "Start chat failed");
      }
    }

    async function loadConversations() {
      try {
        const res = await fetch("/api/conversations?currentUserId=" + encodeURIComponent(currentUser.id));
        const data = await res.json();

        const list = document.getElementById("conversationList");
        if (!res.ok) {
          setStatus("leftStatus", data.error || "Could not load conversations");
          list.innerHTML = "";
          return;
        }

        const items = data.conversations || [];
        if (!items.length) {
          list.innerHTML = '<div class="empty">No chats yet.</div>';
          return;
        }

        list.innerHTML = items.map(item => {
          return \`
            <div class="conversation-item" onclick="openChat('\${item.id}', {
              id: '\${item.other_user_id}',
              userNumber: '\${item.other_user_number}',
              profileName: \${JSON.stringify(item.other_profile_name || "")},
              profilePictureUrl: \${JSON.stringify(item.other_profile_picture_url || "")}
            })">
              <div><strong>\${escapeHtml(item.other_profile_name || "Unknown")}</strong></div>
              <div class="muted">\${escapeHtml(item.other_user_number || "")}</div>
              <div class="muted">\${escapeHtml(item.last_message || "")}</div>
            </div>
          \`;
        }).join("");
      } catch (err) {
        setStatus("leftStatus", "Load conversations failed");
      }
    }

    async function openChat(conversationId, targetUser) {
      currentConversationId = conversationId;
      currentChatTarget = targetUser;

      document.getElementById("chatEmptyState").classList.add("hidden");
      document.getElementById("chatPanel").classList.remove("hidden");

      document.getElementById("chatName").innerHTML = "<strong>" + escapeHtml(targetUser.profileName || "") + "</strong>";
      document.getElementById("chatUserNumber").textContent = targetUser.userNumber || "";
      document.getElementById("chatAvatar").src = avatarValue(targetUser.profilePictureUrl || "");

      await loadMessages();
    }

    async function loadMessages() {
      try {
        setStatus("chatStatus", "");

        const res = await fetch(
          "/api/messages?conversationId=" + encodeURIComponent(currentConversationId) +
          "&currentUserId=" + encodeURIComponent(currentUser.id)
        );
        const data = await res.json();

        if (!res.ok) {
          setStatus("chatStatus", data.error || "Could not load messages");
          return;
        }

        const box = document.getElementById("messagesBox");
        const messages = data.messages || [];

        if (!messages.length) {
          box.innerHTML = '<div class="empty">No messages yet.</div>';
          return;
        }

        box.innerHTML = messages.map(msg => {
          const mine = msg.sender_id === currentUser.id;
          return \`
            <div class="message \${mine ? "mine" : "theirs"}">
              <div class="message-meta">
                \${escapeHtml(msg.profile_name || "")} • \${escapeHtml(msg.user_number || "")}
              </div>
              <div>\${escapeHtml(msg.body || "")}</div>
              <div class="message-meta">
                \${escapeHtml(msg.updated_at && msg.updated_at !== msg.created_at ? "Edited • " : "")}\${escapeHtml(msg.updated_at || msg.created_at || "")}
              </div>
              \${mine ? \`
                <div class="message-actions">
                  <button class="secondary" onclick="editMessage('\${msg.id}', \${JSON.stringify(msg.body || "")})">Edit</button>
                  <button class="danger" onclick="deleteMessage('\${msg.id}')">Delete</button>
                </div>
              \` : ""}
            </div>
          \`;
        }).join("");

        box.scrollTop = box.scrollHeight;
      } catch (err) {
        setStatus("chatStatus", "Load messages failed");
      }
    }

    async function sendMessage() {
      try {
        setStatus("chatStatus", "");

        const message = document.getElementById("messageInput").value.trim();
        if (!currentConversationId) {
          setStatus("chatStatus", "Open a conversation first");
          return;
        }
        if (!message) {
          setStatus("chatStatus", "Type a message");
          return;
        }

        const res = await fetch("/api/send-message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: currentConversationId,
            senderId: currentUser.id,
            message
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("chatStatus", data.error || "Could not send message");
          return;
        }

        document.getElementById("messageInput").value = "";
        await loadMessages();
        await loadConversations();
      } catch (err) {
        setStatus("chatStatus", "Send message failed");
      }
    }

    async function editMessage(messageId, oldBody) {
      const nextBody = prompt("Edit message", oldBody || "");
      if (nextBody === null) return;

      try {
        const res = await fetch("/api/edit-message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messageId,
            currentUserId: currentUser.id,
            message: nextBody.trim()
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("chatStatus", data.error || "Could not edit message");
          return;
        }

        setStatus("chatStatus", "Message updated", true);
        await loadMessages();
        await loadConversations();
      } catch (err) {
        setStatus("chatStatus", "Edit message failed");
      }
    }

    async function deleteMessage(messageId) {
      if (!confirm("Delete this message?")) return;

      try {
        const res = await fetch("/api/delete-message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messageId,
            currentUserId: currentUser.id
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("chatStatus", data.error || "Could not delete message");
          return;
        }

        setStatus("chatStatus", "Message deleted", true);
        await loadMessages();
        await loadConversations();
      } catch (err) {
        setStatus("chatStatus", "Delete message failed");
      }
    }

    async function hideConversation() {
      if (!currentConversationId) return;
      if (!confirm("Hide this chat from your list?")) return;

      try {
        const res = await fetch("/api/hide-conversation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: currentConversationId,
            currentUserId: currentUser.id
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("chatStatus", data.error || "Could not hide chat");
          return;
        }

        setStatus("chatStatus", "Chat hidden", true);
        currentConversationId = null;
        currentChatTarget = null;
        document.getElementById("chatPanel").classList.add("hidden");
        document.getElementById("chatEmptyState").classList.remove("hidden");
        await loadConversations();
      } catch (err) {
        setStatus("chatStatus", "Hide chat failed");
      }
    }

    loadSession();
  </script>
</body>
</html>
`;
}
