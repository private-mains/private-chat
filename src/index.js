export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return htmlResponse(renderApp());
    }

    if (url.pathname === "/api/bootstrap" && request.method === "POST") {
      try {
        const body = await request.json();
        const deviceSecret = String(body.deviceSecret || "").trim();

        if (!deviceSecret) {
          return json({ error: "Missing device secret" }, 400);
        }

        const user = await env.DB.prepare(
          `SELECT id, user_number, profile_name, profile_picture_url
           FROM users
           WHERE device_secret = ?`
        ).bind(deviceSecret).first();

        if (!user) {
          return json({ found: false });
        }

        return json({
          found: true,
          user: {
            id: user.id,
            userNumber: user.user_number,
            profileName: user.profile_name,
            profilePictureUrl: user.profile_picture_url || ""
          }
        });
      } catch (error) {
        return json({ error: "Bootstrap failed: " + errMsg(error) }, 500);
      }
    }

    if (url.pathname === "/api/create-profile" && request.method === "POST") {
      try {
        const body = await request.json();
        const profileName = String(body.profileName || "").trim();
        const profilePictureUrl = String(body.profilePictureUrl || "").trim();
        const deviceSecret = String(body.deviceSecret || "").trim();

        if (!profileName || !deviceSecret) {
          return json({ error: "Profile name is required" }, 400);
        }

        const existing = await env.DB.prepare(
          `SELECT id, user_number, profile_name, profile_picture_url
           FROM users
           WHERE device_secret = ?`
        ).bind(deviceSecret).first();

        if (existing) {
          return json({
            success: true,
            user: {
              id: existing.id,
              userNumber: existing.user_number,
              profileName: existing.profile_name,
              profilePictureUrl: existing.profile_picture_url || ""
            }
          });
        }

        const userId = crypto.randomUUID();
        const userNumber = await generateUserNumber(env.DB);
        const createdAt = nowIso();

        await env.DB.prepare(
          `INSERT INTO users (id, user_number, profile_name, profile_picture_url, device_secret, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          userId,
          userNumber,
          profileName,
          profilePictureUrl || null,
          deviceSecret,
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
        return json({ error: "Create profile failed: " + errMsg(error) }, 500);
      }
    }

    if (url.pathname === "/api/update-profile" && request.method === "POST") {
      try {
        const body = await request.json();
        const currentUserId = String(body.currentUserId || "").trim();
        const profileName = String(body.profileName || "").trim();
        const profilePictureUrl = String(body.profilePictureUrl || "").trim();

        if (!currentUserId || !profileName) {
          return json({ error: "Missing profile data" }, 400);
        }

        await env.DB.prepare(
          `UPDATE users
           SET profile_name = ?, profile_picture_url = ?
           WHERE id = ?`
        ).bind(profileName, profilePictureUrl || null, currentUserId).run();

        return json({ success: true });
      } catch (error) {
        return json({ error: "Update profile failed: " + errMsg(error) }, 500);
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

        const targetUser = await env.DB.prepare(
          `SELECT id, user_number, profile_name, profile_picture_url
           FROM users
           WHERE user_number = ?`
        ).bind(targetUserNumber).first();

        if (!targetUser) {
          return json({ error: "User not found" }, 404);
        }

        if (targetUser.id === currentUserId) {
          return json({ error: "You cannot chat with yourself" }, 400);
        }

        const ordered = [currentUserId, targetUser.id].sort();
        const userA = ordered[0];
        const userB = ordered[1];

        let conversation = await env.DB.prepare(
          `SELECT id
           FROM conversations
           WHERE user_a_id = ? AND user_b_id = ?`
        ).bind(userA, userB).first();

        if (!conversation) {
          const conversationId = crypto.randomUUID();
          const timestamp = nowIso();

          await env.DB.prepare(
            `INSERT INTO conversations (id, user_a_id, user_b_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`
          ).bind(conversationId, userA, userB, timestamp, timestamp).run();

          conversation = { id: conversationId };
        }

        await env.DB.prepare(
          `DELETE FROM hidden_conversations
           WHERE conversation_id = ? AND user_id IN (?, ?)`
        ).bind(conversation.id, currentUserId, targetUser.id).run();

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

        const result = await env.DB.prepare(
          `SELECT
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
           ORDER BY c.updated_at DESC`
        ).bind(currentUserId, currentUserId, currentUserId, currentUserId).all();

        return json({ success: true, conversations: result.results || [] });
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

        const result = await env.DB.prepare(
          `SELECT
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
           ORDER BY m.created_at ASC`
        ).bind(conversationId).all();

        return json({ success: true, messages: result.results || [] });
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

        await env.DB.prepare(
          `INSERT INTO messages (id, conversation_id, sender_id, body, created_at, updated_at, is_deleted)
           VALUES (?, ?, ?, ?, ?, ?, 0)`
        ).bind(messageId, conversationId, senderId, message, timestamp, timestamp).run();

        await env.DB.prepare(
          `UPDATE conversations
           SET updated_at = ?
           WHERE id = ?`
        ).bind(timestamp, conversationId).run();

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

        const row = await env.DB.prepare(
          `SELECT id, conversation_id, sender_id
           FROM messages
           WHERE id = ? AND is_deleted = 0`
        ).bind(messageId).first();

        if (!row) {
          return json({ error: "Message not found" }, 404);
        }

        if (row.sender_id !== currentUserId) {
          return json({ error: "You can only edit your own message" }, 403);
        }

        const timestamp = nowIso();

        await env.DB.prepare(
          `UPDATE messages
           SET body = ?, updated_at = ?
           WHERE id = ?`
        ).bind(message, timestamp, messageId).run();

        await env.DB.prepare(
          `UPDATE conversations
           SET updated_at = ?
           WHERE id = ?`
        ).bind(timestamp, row.conversation_id).run();

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

        const row = await env.DB.prepare(
          `SELECT id, conversation_id, sender_id
           FROM messages
           WHERE id = ? AND is_deleted = 0`
        ).bind(messageId).first();

        if (!row) {
          return json({ error: "Message not found" }, 404);
        }

        if (row.sender_id !== currentUserId) {
          return json({ error: "You can only delete your own message" }, 403);
        }

        const timestamp = nowIso();

        await env.DB.prepare(
          `UPDATE messages
           SET is_deleted = 1, updated_at = ?
           WHERE id = ?`
        ).bind(timestamp, messageId).run();

        await env.DB.prepare(
          `UPDATE conversations
           SET updated_at = ?
           WHERE id = ?`
        ).bind(timestamp, row.conversation_id).run();

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

        await env.DB.prepare(
          `INSERT OR REPLACE INTO hidden_conversations (id, conversation_id, user_id, hidden_at)
           VALUES (?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), conversationId, currentUserId, nowIso()).run();

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

async function canAccessConversation(db, userId, conversationId) {
  const row = await db.prepare(
    `SELECT id
     FROM conversations
     WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)`
  ).bind(conversationId, userId, userId).first();

  return !!row;
}

async function generateUserNumber(db) {
  while (true) {
    const number = String(Math.floor(100000000 + Math.random() * 900000000));
    const exists = await db.prepare(
      `SELECT id FROM users WHERE user_number = ?`
    ).bind(number).first();

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
      font-family: Inter, Arial, sans-serif;
      background: #f3f5f7;
      color: #111827;
    }
    .container {
      max-width: 1150px;
      margin: 0 auto;
      padding: 18px;
    }
    .topbar {
      background: linear-gradient(135deg, #111827, #1f2937);
      color: white;
      padding: 18px 20px;
      border-radius: 18px;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      box-shadow: 0 10px 30px rgba(0,0,0,0.12);
    }
    .brand {
      font-size: 30px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .sub {
      font-size: 13px;
      color: #d1d5db;
      margin-top: 4px;
    }
    .hidden { display: none !important; }
    .card {
      background: white;
      border-radius: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.06);
      padding: 20px;
    }
    .welcome {
      text-align: center;
      max-width: 520px;
      margin: 40px auto;
    }
    .welcome h2 {
      margin-top: 0;
      font-size: 32px;
    }
    .welcome p {
      color: #6b7280;
      margin-bottom: 20px;
    }
    .layout {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 16px;
    }
    .section-title {
      margin: 0 0 14px;
      font-size: 20px;
      font-weight: 700;
    }
    input, textarea, button {
      width: 100%;
      padding: 13px 14px;
      border-radius: 12px;
      border: 1px solid #d1d5db;
      font-size: 14px;
      margin-bottom: 10px;
    }
    textarea {
      min-height: 78px;
      resize: vertical;
    }
    button {
      border: none;
      cursor: pointer;
      background: #111827;
      color: white;
      font-weight: 600;
    }
    button:hover {
      opacity: 0.95;
    }
    button.secondary {
      background: #e5e7eb;
      color: #111827;
    }
    button.danger {
      background: #b91c1c;
      color: white;
    }
    .status {
      min-height: 18px;
      margin: 6px 0 12px;
      font-size: 13px;
      color: #b91c1c;
    }
    .ok {
      color: #047857;
    }
    .profile-box {
      background: #f8fafc;
      padding: 14px;
      border-radius: 16px;
      margin-bottom: 14px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .avatar {
      width: 52px;
      height: 52px;
      border-radius: 50%;
      object-fit: cover;
      background: #d1d5db;
    }
    .muted {
      color: #6b7280;
      font-size: 12px;
    }
    .conversation-item {
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      padding: 12px;
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
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .messages {
      height: 460px;
      overflow-y: auto;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      padding: 14px;
      background: #f9fafb;
      margin-bottom: 12px;
    }
    .message {
      max-width: 78%;
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
      text-align: center;
      color: #6b7280;
      padding: 22px 0;
    }
    @media (max-width: 920px) {
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
      <div id="topUserInfo" class="sub">Setting up...</div>
    </div>

    <div id="setupPanel" class="card welcome hidden">
      <h2>Welcome to Private Chat</h2>
      <p>Create your profile once on this device and start chatting by user number.</p>
      <div class="status" id="setupStatus"></div>
      <input id="setupProfileName" placeholder="Your profile name" />
      <input id="setupProfilePictureUrl" placeholder="Profile picture URL (optional)" />
      <button id="createProfileBtn">Continue</button>
    </div>

    <div id="appPanel" class="layout hidden">
      <div class="card">
        <div class="profile-box">
          <div class="row">
            <img id="myAvatar" class="avatar" alt="avatar" />
            <div>
              <div id="myProfileName"><strong></strong></div>
              <div class="muted">Your user number: <span id="myUserNumber"></span></div>
            </div>
          </div>
        </div>

        <div class="status" id="leftStatus"></div>

        <div class="section-title">Start chat</div>
        <input id="startChatUserNumber" placeholder="Enter user number" />
        <button id="startChatBtn">Open chat</button>

        <div class="section-title" style="margin-top:16px;">Edit profile</div>
        <input id="editProfileName" placeholder="Profile name" />
        <input id="editProfilePictureUrl" placeholder="Profile picture URL" />
        <button class="secondary" id="saveProfileBtn">Save profile</button>

        <div class="section-title" style="margin-top:16px;">Your chats</div>
        <div id="conversationList"></div>

        <button class="danger" style="margin-top:10px;" id="resetDeviceBtn">Reset this device</button>
      </div>

      <div class="card">
        <div id="chatEmptyState" class="empty">Open a chat by user number.</div>

        <div id="chatPanel" class="hidden">
          <div class="chat-header">
            <div class="row">
              <img id="chatAvatar" class="avatar" alt="chat avatar" />
              <div>
                <div id="chatName"><strong></strong></div>
                <div class="muted">User number: <span id="chatUserNumber"></span></div>
              </div>
            </div>
            <div>
              <button class="secondary" id="hideChatBtn">Hide chat</button>
            </div>
          </div>

          <div class="status" id="chatStatus"></div>
          <div id="messagesBox" class="messages"></div>

          <textarea id="messageInput" placeholder="Type your message"></textarea>
          <button id="sendMessageBtn">Send Message</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentUser = null;
    let currentConversationId = null;
    let currentChatTarget = null;

    function getDeviceSecret() {
      let secret = localStorage.getItem("privateChatDeviceSecret");
      if (!secret) {
        secret = "pc_" + crypto.randomUUID();
        localStorage.setItem("privateChatDeviceSecret", secret);
      }
      return secret;
    }

    function setStatus(id, text, ok) {
      const el = document.getElementById(id);
      el.textContent = text || "";
      el.className = ok ? "status ok" : "status";
    }

    function escapeHtml(str) {
      return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function avatarValue(url) {
      return url && url.trim() ? url.trim() : "https://via.placeholder.com/64?text=U";
    }

    async function bootstrap() {
      try {
        const res = await fetch("/api/bootstrap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceSecret: getDeviceSecret() })
        });

        const data = await res.json();

        if (data.found && data.user) {
          currentUser = data.user;
          showApp();
          return;
        }

        showSetup();
      } catch (err) {
        showSetup();
      }
    }

    function showSetup() {
      document.getElementById("setupPanel").classList.remove("hidden");
      document.getElementById("appPanel").classList.add("hidden");
      document.getElementById("topUserInfo").textContent = "Create your profile";
    }

    function showApp() {
      document.getElementById("setupPanel").classList.add("hidden");
      document.getElementById("appPanel").classList.remove("hidden");

      document.getElementById("myProfileName").innerHTML = "<strong>" + escapeHtml(currentUser.profileName) + "</strong>";
      document.getElementById("myUserNumber").textContent = currentUser.userNumber;
      document.getElementById("myAvatar").src = avatarValue(currentUser.profilePictureUrl);
      document.getElementById("editProfileName").value = currentUser.profileName || "";
      document.getElementById("editProfilePictureUrl").value = currentUser.profilePictureUrl || "";
      document.getElementById("topUserInfo").textContent = currentUser.profileName + " • " + currentUser.userNumber;

      loadConversations();
    }

    async function createProfile() {
      try {
        setStatus("setupStatus", "", false);

        const profileName = document.getElementById("setupProfileName").value.trim();
        const profilePictureUrl = document.getElementById("setupProfilePictureUrl").value.trim();

        const res = await fetch("/api/create-profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            profileName: profileName,
            profilePictureUrl: profilePictureUrl,
            deviceSecret: getDeviceSecret()
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("setupStatus", data.error || "Could not create profile", false);
          return;
        }

        currentUser = data.user;
        showApp();
        setStatus("leftStatus", "Your user number is " + currentUser.userNumber, true);
      } catch (err) {
        setStatus("setupStatus", "Create profile failed", false);
      }
    }

    async function updateProfile() {
      try {
        setStatus("leftStatus", "", false);

        const profileName = document.getElementById("editProfileName").value.trim();
        const profilePictureUrl = document.getElementById("editProfilePictureUrl").value.trim();

        const res = await fetch("/api/update-profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            currentUserId: currentUser.id,
            profileName: profileName,
            profilePictureUrl: profilePictureUrl
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("leftStatus", data.error || "Could not update profile", false);
          return;
        }

        currentUser.profileName = profileName;
        currentUser.profilePictureUrl = profilePictureUrl;
        showApp();
        setStatus("leftStatus", "Profile updated", true);
      } catch (err) {
        setStatus("leftStatus", "Update profile failed", false);
      }
    }

    function resetThisDevice() {
      if (!confirm("Reset this device profile?")) return;
      localStorage.removeItem("privateChatDeviceSecret");
      location.reload();
    }

    async function startChat() {
      try {
        setStatus("leftStatus", "", false);

        const targetUserNumber = document.getElementById("startChatUserNumber").value.trim();
        if (!targetUserNumber) {
          setStatus("leftStatus", "Enter a user number", false);
          return;
        }

        const res = await fetch("/api/start-chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            currentUserId: currentUser.id,
            targetUserNumber: targetUserNumber
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("leftStatus", data.error || "Could not start chat", false);
          return;
        }

        currentConversationId = data.conversationId;
        currentChatTarget = data.targetUser;
        document.getElementById("startChatUserNumber").value = "";
        setStatus("leftStatus", "Chat opened", true);
        await loadConversations();
        await openChat(currentConversationId, currentChatTarget);
      } catch (err) {
        setStatus("leftStatus", "Start chat failed", false);
      }
    }

    async function loadConversations() {
      try {
        const res = await fetch("/api/conversations?currentUserId=" + encodeURIComponent(currentUser.id));
        const data = await res.json();
        const list = document.getElementById("conversationList");

        if (!res.ok) {
          setStatus("leftStatus", data.error || "Could not load conversations", false);
          list.innerHTML = "";
          return;
        }

        const items = data.conversations || [];
        if (!items.length) {
          list.innerHTML = '<div class="empty">No chats yet.</div>';
          return;
        }

        let html = "";
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const profileName = JSON.stringify(item.other_profile_name || "");
          const profilePictureUrl = JSON.stringify(item.other_profile_picture_url || "");
          html += '<div class="conversation-item" data-id="' + item.id + '" data-other-id="' + item.other_user_id + '" data-other-number="' + escapeHtml(item.other_user_number || "") + '" data-other-name=' + profileName + ' data-other-photo=' + profilePictureUrl + '>';
          html += '<div><strong>' + escapeHtml(item.other_profile_name || "Unknown") + '</strong></div>';
          html += '<div class="muted">' + escapeHtml(item.other_user_number || "") + '</div>';
          html += '<div class="muted">' + escapeHtml(item.last_message || "") + '</div>';
          html += '</div>';
        }

        list.innerHTML = html;

        const cards = list.querySelectorAll(".conversation-item");
        cards.forEach(function(card) {
          card.addEventListener("click", function() {
            openChat(card.getAttribute("data-id"), {
              id: card.getAttribute("data-other-id"),
              userNumber: card.getAttribute("data-other-number"),
              profileName: JSON.parse(card.getAttribute("data-other-name")),
              profilePictureUrl: JSON.parse(card.getAttribute("data-other-photo"))
            });
          });
        });
      } catch (err) {
        setStatus("leftStatus", "Load conversations failed", false);
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
        setStatus("chatStatus", "", false);

        const res = await fetch("/api/messages?conversationId=" + encodeURIComponent(currentConversationId) + "&currentUserId=" + encodeURIComponent(currentUser.id));
        const data = await res.json();

        if (!res.ok) {
          setStatus("chatStatus", data.error || "Could not load messages", false);
          return;
        }

        const box = document.getElementById("messagesBox");
        const messages = data.messages || [];

        if (!messages.length) {
          box.innerHTML = '<div class="empty">No messages yet.</div>';
          return;
        }

        let html = "";
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const mine = msg.sender_id === currentUser.id;
          html += '<div class="message ' + (mine ? "mine" : "theirs") + '">';
          html += '<div class="message-meta">' + escapeHtml(msg.profile_name || "") + ' • ' + escapeHtml(msg.user_number || "") + '</div>';
          html += '<div>' + escapeHtml(msg.body || "") + '</div>';
          html += '<div class="message-meta">' + escapeHtml((msg.updated_at && msg.updated_at !== msg.created_at ? "Edited • " : "") + (msg.updated_at || msg.created_at || "")) + '</div>';
          if (mine) {
            html += '<div class="message-actions">';
            html += '<button class="secondary" data-edit-id="' + msg.id + '" data-edit-body="' + escapeHtml(msg.body || "") + '">Edit</button>';
            html += '<button class="danger" data-delete-id="' + msg.id + '">Delete</button>';
            html += '</div>';
          }
          html += '</div>';
        }

        box.innerHTML = html;
        box.scrollTop = box.scrollHeight;

        const editButtons = box.querySelectorAll("[data-edit-id]");
        editButtons.forEach(function(btn) {
          btn.addEventListener("click", function() {
            editMessage(btn.getAttribute("data-edit-id"), btn.getAttribute("data-edit-body"));
          });
        });

        const deleteButtons = box.querySelectorAll("[data-delete-id]");
        deleteButtons.forEach(function(btn) {
          btn.addEventListener("click", function() {
            deleteMessage(btn.getAttribute("data-delete-id"));
          });
        });
      } catch (err) {
        setStatus("chatStatus", "Load messages failed", false);
      }
    }

    async function sendMessage() {
      try {
        setStatus("chatStatus", "", false);

        const message = document.getElementById("messageInput").value.trim();
        if (!currentConversationId) {
          setStatus("chatStatus", "Open a chat first", false);
          return;
        }
        if (!message) {
          setStatus("chatStatus", "Type a message", false);
          return;
        }

        const res = await fetch("/api/send-message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: currentConversationId,
            senderId: currentUser.id,
            message: message
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("chatStatus", data.error || "Could not send message", false);
          return;
        }

        document.getElementById("messageInput").value = "";
        await loadMessages();
        await loadConversations();
      } catch (err) {
        setStatus("chatStatus", "Send message failed", false);
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
            messageId: messageId,
            currentUserId: currentUser.id,
            message: nextBody.trim()
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("chatStatus", data.error || "Could not edit message", false);
          return;
        }

        setStatus("chatStatus", "Message updated", true);
        await loadMessages();
        await loadConversations();
      } catch (err) {
        setStatus("chatStatus", "Edit message failed", false);
      }
    }

    async function deleteMessage(messageId) {
      if (!confirm("Delete this message?")) return;

      try {
        const res = await fetch("/api/delete-message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messageId: messageId,
            currentUserId: currentUser.id
          })
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("chatStatus", data.error || "Could not delete message", false);
          return;
        }

        setStatus("chatStatus", "Message deleted", true);
        await loadMessages();
        await loadConversations();
      } catch (err) {
        setStatus("chatStatus", "Delete message failed", false);
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
          setStatus("chatStatus", data.error || "Could not hide chat", false);
          return;
        }

        setStatus("chatStatus", "Chat hidden", true);
        currentConversationId = null;
        currentChatTarget = null;
        document.getElementById("chatPanel").classList.add("hidden");
        document.getElementById("chatEmptyState").classList.remove("hidden");
        await loadConversations();
      } catch (err) {
        setStatus("chatStatus", "Hide chat failed", false);
      }
    }

    document.addEventListener("DOMContentLoaded", function() {
      document.getElementById("createProfileBtn").addEventListener("click", createProfile);
      document.getElementById("startChatBtn").addEventListener("click", startChat);
      document.getElementById("saveProfileBtn").addEventListener("click", updateProfile);
      document.getElementById("resetDeviceBtn").addEventListener("click", resetThisDevice);
      document.getElementById("sendMessageBtn").addEventListener("click", sendMessage);
      document.getElementById("hideChatBtn").addEventListener("click", hideConversation);
      bootstrap();
    });
  </script>
</body>
</html>
`;
}
