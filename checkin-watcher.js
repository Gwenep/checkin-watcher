async function getTasks(KV) {
  const data = await KV.get("tasks_list");
  return data ? JSON.parse(data) : [];
}

async function saveTasks(KV, tasks) {
  await KV.put("tasks_list", JSON.stringify(tasks));
}

async function getEmailSettings(KV) {
  const data = await KV.get("email_settings");
  return data ? JSON.parse(data) : {
    recipients: [],
    triggers: [24, 12, 6, 1],
    sendMode: 'important',
    fromEmail: 'onboarding@resend.dev',
    sentNotifications: {}
  };
}

async function sendEmail(env, settings, subject, htmlContent) {
  if (!env.RESEND_API) return false;
  if (!settings.recipients || settings.recipients.length === 0) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: settings.fromEmail || 'onboarding@resend.dev',
        to: settings.recipients,
        subject: subject,
        html: htmlContent
      })
    });
    return res.ok;
  } catch (e) {
    console.error('Send email error:', e);
    return false;
  }
}

function formatRemainingTime(ms) {
  if (ms <= 0) return '已超时';
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hrs = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const mins = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  let str = '';
  if (days > 0) str += days + '天 ';
  str += hrs + '小时 ' + mins + '分钟';
  return str;
}

// 任务名称、网址等均为用户输入，拼进 HTML/邮件前必须转义
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 仅允许 http(s) 链接，避免 javascript: 等协议进入邮件/页面
function safeHttpUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'http://' + raw;
  try {
    const parsed = new URL(withScheme);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch (e) {
    return '';
  }
}

// 定长比较，避免密码逐字符比较带来的时间侧信道
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 截止时间 = 周期起点 + 周期。周期起点 cycleBase 由前端存入（本地时区的"第二天0点"），
// Worker 在 UTC 时区无法还原用户本地 0 点，所以只读取。
// 旧数据/勾选任务没有 cycleBase 时回退 lastCheckIn（勾选任务 lastCheckIn 即签到时刻）。
function taskDeadline(task) {
  const base = typeof task.cycleBase === 'number' ? task.cycleBase : task.lastCheckIn;
  return base + task.countdownHours * 60 * 60 * 1000;
}

function createEmailHtml(task, remainingMs) {
  const deadline = new Date(taskDeadline(task));
  const remaining = formatRemainingTime(remainingMs);
  const isImportant = task.importance === 'important';
  const taskName = escapeHtml(task.name);
  const targetUrl = safeHttpUrl(task.targetUrl);
  const button = targetUrl
    ? `<a href="${escapeHtml(targetUrl)}" target="_blank" style="display: inline-block; background: #52c41a; color: #ffffff; padding: 11px 22px; border-radius: 8px; text-decoration: none; font-size: 15px; font-weight: 600;">去签到 →</a>`
    : '';
  return `
    <div style="margin: 0; padding: 24px 12px; background: #f5f7fa; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;">
      <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border: 1px solid #e8ecf2; border-radius: 14px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #1890ff, #096dd9); padding: 22px 26px; color: #ffffff;">
          <div style="font-size: 12px; letter-spacing: 0.12em; opacity: 0.85;">CHECKIN WATCHER</div>
          <div style="font-size: 21px; font-weight: 700; margin-top: 6px;">⏰ 签到提醒</div>
        </div>
        <div style="padding: 24px 26px;">
          <p style="margin: 0 0 6px; font-size: 13px; color: #8c8c8c;">任务</p>
          <p style="margin: 0 0 18px; font-size: 18px; font-weight: 600; color: #1f2329;">
            ${taskName}${isImportant ? ' ⭐' : ''}
          </p>
          <div style="background: #fff7e6; border: 1px solid #ffe0a3; border-radius: 10px; padding: 14px 16px; margin-bottom: 18px;">
            <p style="margin: 0; font-size: 15px; color: #d46b08;">剩余 <strong>${remaining}</strong></p>
            <p style="margin: 6px 0 0; font-size: 13px; color: #8c6d3f;">截止时间：${escapeHtml(deadline.toLocaleString('zh-CN'))}</p>
          </div>
          ${button}
          <p style="margin: 22px 0 0; padding-top: 16px; border-top: 1px solid #f0f0f0; font-size: 12px; color: #b0b4ba;">
            此邮件由 Checkin Watcher 自动发送，请勿直接回复。
          </p>
        </div>
      </div>
    </div>
  `;
}

async function checkAndSendNotifications(env, KV) {
  if (!env.RESEND_API) return;
  const settings = await getEmailSettings(KV);
  if (!settings.recipients || settings.recipients.length === 0) return;
  if (!settings.triggers || settings.triggers.length === 0) return;

  const tasks = await getTasks(KV);
  if (tasks.length === 0) return;

  const now = Date.now();
  const sentNotifications = settings.sentNotifications || {};
  let newSent = false;
  let notificationsToSend = [];

  for (const task of tasks) {
    if (settings.sendMode === 'important' && task.importance !== 'important') continue;

    const deadline = taskDeadline(task);
    const remaining = deadline - now;
    if (remaining <= 0) continue;

    // 收集所有已越过（剩余 <= 触发小时数）且未发送过的阈值并全部标记。
    // 若只标一个，24h 标记一旦丢失（并发覆盖/发送失败），之后会以 12h 阈值补发，
    // 用户就会在"应该 24h 提醒"时收到"还剩 12 小时"的邮件。
    const crossedKeys = [];
    for (const trigger of settings.triggers) {
      if (remaining <= trigger * 60 * 60 * 1000) {
        const key = `${task.id}_${task.lastCheckIn}_${trigger}`;
        if (!sentNotifications[key]) crossedKeys.push(key);
      }
    }
    if (crossedKeys.length > 0) {
      notificationsToSend.push({ task, remaining, keys: crossedKeys });
    }
  }

  for (const n of notificationsToSend) {
    const subject = `⏰ 签到提醒：${n.task.name} - 还剩 ${formatRemainingTime(n.remaining)}`;
    const html = createEmailHtml(n.task, n.remaining);
    const ok = await sendEmail(env, settings, subject, html);
    if (ok) {
      for (const k of n.keys) sentNotifications[k] = now;
      newSent = true;
    }
  }

  if (newSent) {
    // 合并写入：定时器、页面加载、签到都会触发本检查并发读改写 email_settings，
    // 整份覆盖会把并发方刚写入的标记冲掉，导致重复或错位发信。
    const fresh = await getEmailSettings(KV);
    fresh.sentNotifications = { ...(fresh.sentNotifications || {}), ...sentNotifications };
    await KV.put("email_settings", JSON.stringify(fresh));
  }
}

export default {
  scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndSendNotifications(env, env.SIGN_IN_KV));
  },

  async fetch(request, env, ctx) {
    if (!env.SIGN_IN_KV) {
      return new Response("环境报错：请在 Worker 的 Settings -> Variables 中绑定 KV 命名空间，变量名必须为 SIGN_IN_KV", {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    const url = new URL(request.url);
    const KV = env.SIGN_IN_KV;

    async function authenticate(request) {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
      const token = authHeader.slice(7);
      if (!token) return false;
      const sessionValue = await KV.get(`session_${token}`);
      return sessionValue === "valid";
    }

    // 获取任务列表（无需登录）
    if (url.pathname === "/api/tasks") {
      const tasks = await getTasks(KV);
      ctx.waitUntil(checkAndSendNotifications(env, KV));
      return new Response(JSON.stringify({ tasks, serverTime: Date.now() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 登录接口
    if (url.pathname === "/api/login" && request.method === "POST") {
      if (!env.ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ success: false, error: "管理员密码未设置，请在 Worker 环境变量中配置 ADMIN_PASSWORD" }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      // 简单限流：同一 IP 10 分钟内最多失败 10 次，避免密码被暴力枚举
      const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
      const failKey = `login_fail_${clientIp}`;
      const failCount = parseInt(await KV.get(failKey) || "0", 10) || 0;
      if (failCount >= 10) {
        return new Response(JSON.stringify({ success: false, error: "尝试次数过多，请 10 分钟后再试" }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      try {
        const body = await request.json();
        const password = body.password || "";
        if (!safeEqual(password, env.ADMIN_PASSWORD)) {
          await KV.put(failKey, String(failCount + 1), { expirationTtl: 10 * 60 });
          return new Response(JSON.stringify({ success: false, error: "密码错误" }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        await KV.delete(failKey);
        const token = crypto.randomUUID();
        await KV.put(`session_${token}`, "valid", { expirationTtl: 8 * 60 * 60 });
        return new Response(JSON.stringify({ success: true, token }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "请求格式错误" }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 验证 token 是否有效
    if (url.pathname === "/api/verify" && request.method === "GET") {
      const isValid = await authenticate(request);
      return new Response(JSON.stringify({ valid: isValid }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 登出接口
    if (url.pathname === "/api/logout" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        await KV.delete(`session_${token}`);
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 添加任务（需要登录）
    if (url.pathname === "/api/add" && request.method === "POST") {
      if (!(await authenticate(request))) {
        return new Response(JSON.stringify({ success: false, error: "未登录或登录已过期" }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const body = await request.json();
      const tasks = await getTasks(KV);

      // id 由服务端生成，避免并发/上传自定义 id 造成重复
      let newId = typeof body.id === 'string' && body.id ? body.id : Date.now().toString();
      if (tasks.some(t => t.id === newId)) {
        newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      }

      const newTask = {
        id: newId,
        name: (typeof body.name === 'string' && body.name.trim()) || "未命名任务",
        targetUrl: typeof body.targetUrl === 'string' ? body.targetUrl.trim() : "",
        countdownHours: parseFloat(body.countdownHours) || 24,
        priority: Math.min(100, Math.max(0, parseInt(body.priority) || 0)),
        importance: body.importance === 'important' ? 'important' : 'normal',
        unit: body.unit || 'hours',
        lastCheckIn: body.lastCheckIn || Date.now(),
        cycleBase: typeof body.cycleBase === 'number' ? body.cycleBase : (body.lastCheckIn || Date.now()),
        checkedDate: null,
        includeToday: body.includeToday || false
      };

      tasks.push(newTask);
      await saveTasks(KV, tasks);
      return new Response(JSON.stringify({ success: true, task: newTask }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 编辑任务（需要登录）
    if (url.pathname === "/api/edit" && request.method === "POST") {
      if (!(await authenticate(request))) {
        return new Response(JSON.stringify({ success: false, error: "未登录" }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const body = await request.json();
      let tasks = await getTasks(KV);
      
      tasks = tasks.map(task => {
        if (task.id === body.id) {
          return {
            ...task,
            name: (typeof body.name === 'string' && body.name.trim()) || task.name,
            targetUrl: typeof body.targetUrl === 'string' ? body.targetUrl.trim() : "",
            countdownHours: parseFloat(body.countdownHours) || 24,
            priority: Math.min(100, Math.max(0, parseInt(body.priority) || 0)),
            importance: body.importance === 'important' ? 'important' : 'normal',
            unit: body.unit || task.unit || 'hours',
            includeToday: body.includeToday || false,
            lastCheckIn: body.lastCheckIn !== undefined ? body.lastCheckIn : task.lastCheckIn,
            cycleBase: body.cycleBase !== undefined ? body.cycleBase : (body.lastCheckIn !== undefined ? body.lastCheckIn : task.cycleBase),
            checkedDate: body.checkedDate !== undefined ? body.checkedDate : task.checkedDate
          };
        }
        return task;
      });

      await saveTasks(KV, tasks);
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 签到重置（无需登录）
    if (url.pathname === "/api/checkin" && request.method === "POST") {
      const body = await request.json();
      const taskId = body.id;
      const newLastCheckIn = body.lastCheckIn;
      const newCycleBase = body.cycleBase;
      const checkedDate = body.checkedDate;

      if (!taskId) {
        return new Response(JSON.stringify({ success: false, error: "缺少 id" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      let tasks = await getTasks(KV);
      tasks = tasks.map(task => {
        if (task.id === taskId) {
          const lc = newLastCheckIn || Date.now();
          return {
            ...task,
            lastCheckIn: lc,
            cycleBase: typeof newCycleBase === 'number' ? newCycleBase : lc,
            checkedDate: checkedDate || null
          };
        }
        return task;
      });

      await saveTasks(KV, tasks);

      // Clear sent notification markers for this task so the next cycle starts fresh
      const emailSettings = await getEmailSettings(KV);
      const sent = emailSettings.sentNotifications || {};
      for (const key of Object.keys(sent)) {
        if (key.startsWith(taskId + '_')) delete sent[key];
      }
      emailSettings.sentNotifications = sent;
      await KV.put("email_settings", JSON.stringify(emailSettings));

      ctx.waitUntil(checkAndSendNotifications(env, KV));
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 删除任务（需要登录）
    if (url.pathname === "/api/delete" && request.method === "POST") {
      if (!(await authenticate(request))) {
        return new Response(JSON.stringify({ success: false, error: "未登录" }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const taskId = url.searchParams.get("id");
      if (!taskId) {
        return new Response(JSON.stringify({ success: false, error: "缺少 id" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      let tasks = await getTasks(KV);
      tasks = tasks.filter(task => task.id !== taskId);
      await saveTasks(KV, tasks);

      // 同步清理该任务的发信标记，避免 KV 中残留无效 key
      const emailSettings = await getEmailSettings(KV);
      const sent = emailSettings.sentNotifications || {};
      let changed = false;
      for (const key of Object.keys(sent)) {
        if (key.startsWith(taskId + '_')) { delete sent[key]; changed = true; }
      }
      if (changed) {
        emailSettings.sentNotifications = sent;
        await KV.put("email_settings", JSON.stringify(emailSettings));
      }

      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 获取邮件通知设置（需要登录）
    if (url.pathname === "/api/email-settings" && request.method === "GET") {
      if (!(await authenticate(request))) {
        return new Response(JSON.stringify({ success: false, error: "未登录" }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const settings = await getEmailSettings(KV);
      const { sentNotifications, ...safeSettings } = settings;
      return new Response(JSON.stringify({ success: true, settings: safeSettings }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 保存邮件通知设置（需要登录）
    if (url.pathname === "/api/email-settings" && request.method === "POST") {
      if (!(await authenticate(request))) {
        return new Response(JSON.stringify({ success: false, error: "未登录" }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const body = await request.json();
      const current = await getEmailSettings(KV);
      const newSettings = {
        recipients: body.recipients || [],
        triggers: body.triggers || [],
        sendMode: body.sendMode || 'important',
        fromEmail: body.fromEmail || 'onboarding@resend.dev',
        sentNotifications: current.sentNotifications || {}
      };
      await KV.put("email_settings", JSON.stringify(newSettings));
      const { sentNotifications, ...safeSettings } = newSettings;
      return new Response(JSON.stringify({ success: true, settings: safeSettings }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 测试邮件发送（需要登录）
    if (url.pathname === "/api/test-email" && request.method === "POST") {
      if (!(await authenticate(request))) {
        return new Response(JSON.stringify({ success: false, error: "未登录" }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (!env.RESEND_API) {
        return new Response(JSON.stringify({ success: false, error: "未配置 RESEND_API 环境变量" }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const settings = await getEmailSettings(KV);
      if (!settings.recipients || settings.recipients.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "请先设置接收邮箱" }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const ok = await sendEmail(env, settings, '📧 签到提醒 - 测试邮件', '<h2>测试邮件</h2><p>邮件发送功能正常 ✅</p><p>这是一封来自签到监控系统的测试邮件。</p>');
      return new Response(JSON.stringify({ success: ok }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 主页面
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light dark">
    <meta name="theme-color" content="#f0f2f5">
    <meta name="description" content="签到监控看板 —— 定时签到、到期倒计时与邮件提醒">
    <title>签到监控看板</title>
    <script>
        // 在首屏绘制前应用主题，避免深色模式下出现白屏闪烁
        try {
            var savedTheme = localStorage.getItem('theme');
            var systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            if (savedTheme === 'dark' || (!savedTheme && systemDark)) {
                document.documentElement.classList.add('dark');
                var themeMeta = document.querySelector('meta[name="theme-color"]');
                if (themeMeta) themeMeta.setAttribute('content', '#131417');
            }
        } catch (e) {}
    </script>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1890ff"/><circle cx="32" cy="32" r="18" fill="none" stroke="#fff" stroke-width="3"/><polyline points="32,22 32,33 40,33" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="38,42 44,48 52,38" fill="none" stroke="#52c41a" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>')}">
    <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js"></script>
    <style>
        :root {
            color-scheme: light;
            --primary: #1890ff; --primary-soft: #f0f5ff; --primary-border: #adc6ff;
            --success: #52c41a; --success-strong: #389e0d; --success-border: #b7eb8f;
            --warning: #faad14; --danger: #ff4d4f;
            --danger-bg: #fff1f0; --danger-border: #ffa39e;
            --bg: #f0f2f5; --card-bg: #fff; --text: #1f2329; --text-secondary: #5c6670; --text-muted: #8c8c8c;
            --border: #ebeef2; --input-bg: #fafbfc; --input-border: #d9dee5; --btn-default-bg: #f0f2f5;
            --important-bg: #fffbe6; --overdue-bg: #fff2f0; --selected-bg: #f0f8ff;
            --status-bg: #f7f9fb; --success-bg: #f6ffed; --error-bg: #fff2f0;
            --skeleton-hi: #f7f8fa;
            --shadow: 0 1px 3px rgba(16,24,40,0.04), 0 4px 12px rgba(16,24,40,0.04);
            --shadow-hover: 0 8px 24px rgba(16,24,40,0.10);
            --page-glow: rgba(24,144,255,0.10);
            --radius: 14px;
            --fill-l: 44%; --fill-ls: 14%;
        }
        /* 深色主题：默认跟随系统，点击右上角 🌙 按钮可手动切换（存 localStorage） */
        :root.dark {
            color-scheme: dark;
            --primary: #40a9ff; --primary-soft: rgba(64,169,255,0.12); --primary-border: rgba(64,169,255,0.45);
            --success: #73d13d; --success-strong: #95de64; --success-border: rgba(115,211,61,0.40);
            --warning: #ffc53d; --danger: #ff7875;
            --danger-bg: rgba(255,77,79,0.10); --danger-border: rgba(255,120,120,0.40);
            --bg: #131417; --card-bg: #1c1d21; --text: #e8eaed; --text-secondary: #b3b8bf; --text-muted: #8f959e;
            --border: #2c2d33; --input-bg: #24252a; --input-border: #3a3b42; --btn-default-bg: #2a2b31;
            --important-bg: rgba(250,173,20,0.08); --overdue-bg: rgba(255,77,79,0.07); --selected-bg: rgba(64,169,255,0.10);
            --status-bg: #24252a; --success-bg: rgba(115,211,61,0.10); --error-bg: rgba(255,77,79,0.10);
            --skeleton-hi: #2c2d33;
            --shadow: 0 1px 3px rgba(0,0,0,0.30), 0 4px 12px rgba(0,0,0,0.25);
            --shadow-hover: 0 8px 24px rgba(0,0,0,0.45);
            --page-glow: rgba(64,169,255,0.10);
            --fill-l: 50%; --fill-ls: 8%;
        }
        *, *::before, *::after { box-sizing: border-box; }
        @property --t { syntax: '<number>'; inherits: false; initial-value: 1; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", Roboto, sans-serif;
            background-color: var(--bg);
            background-image: radial-gradient(1100px 420px at 50% -180px, var(--page-glow), transparent 70%);
            background-repeat: no-repeat;
            background-attachment: fixed;
            margin: 0;
            padding: 20px 20px 40px;
            color: var(--text);
            transition: background-color 0.3s, color 0.3s;
            min-height: 100vh;
            -webkit-text-size-adjust: 100%;
        }
        ::selection { background: var(--primary-soft); color: var(--primary); }
        .layout-container { display: flex; flex-direction: column; gap: 22px; max-width: 1400px; margin: 0 auto; }
        .main-content { display: flex; flex-direction: column; gap: 14px; }
        /* 顶部标题栏 */
        .app-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 2px 2px 0; }
        .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
        .brand-logo { width: 44px; height: 44px; border-radius: 13px; flex-shrink: 0; box-shadow: 0 6px 16px rgba(24,144,255,0.28); }
        .page-title { margin: 0; font-size: 1.5rem; font-weight: 700; line-height: 1.2; letter-spacing: 0.01em; color: var(--text); }
        .brand-sub { margin: 3px 0 0; font-size: 0.8rem; color: var(--text-muted); }
        /* 统计面板 */
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
        .stat-card { display: flex; align-items: center; gap: 14px; background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; box-shadow: var(--shadow); transition: transform 0.2s ease, box-shadow 0.2s ease; }
        .stat-icon { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; font-size: 1.2rem; flex-shrink: 0; }
        .stat-body { min-width: 0; }
        .stat-label { font-size: 0.82rem; color: var(--text-muted); margin-bottom: 4px; white-space: nowrap; }
        .stat-value { font-size: 1.75rem; font-weight: 700; line-height: 1.1; color: var(--text); font-variant-numeric: tabular-nums; }
        .stat-card.stat-blue .stat-icon { background: var(--primary-soft); }
        .stat-card.stat-blue .stat-value { color: var(--primary); }
        .stat-card.stat-green .stat-icon { background: var(--success-bg); }
        .stat-card.stat-green .stat-value { color: var(--success); }
        .stat-card.stat-orange .stat-icon { background: var(--important-bg); }
        .stat-card.stat-orange .stat-value { color: var(--warning); }
        .stat-card.stat-red .stat-icon { background: var(--danger-bg); }
        .stat-card.stat-red .stat-value { color: var(--danger); }
        @media (max-width: 900px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } }
        /* 批量选择 */
        .task-item .task-checkbox { width: 18px; height: 18px; cursor: pointer; accent-color: var(--primary); flex-shrink: 0; }
        .task-item.task-selected { border-color: var(--primary); background-color: var(--selected-bg); box-shadow: 0 0 0 3px var(--primary-soft); }
        .task-item.task-selected.overdue { border-color: var(--danger); box-shadow: 0 0 0 3px var(--danger-bg); }
        .batch-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 8px 12px; box-shadow: var(--shadow); }
        .batch-bar #batchCount { font-size: 0.85rem; font-weight: 600; color: var(--text-muted); margin-right: auto; }
        .batch-bar .btn { padding: 7px 12px; font-size: 0.82rem; }
        .btn-batch-delete { background: var(--danger-bg); color: var(--danger); border: 1px solid var(--danger-border); }
        .btn-ghost { background: var(--btn-default-bg); color: var(--text-secondary); }
        .btn-block { width: 100%; }
        /* 任务进度条 */
        .task-progress-wrap { grid-column: 1 / -1; }
        .task-progress { display: flex; align-items: center; gap: 10px; }
        .task-progress-bar { flex: 1; height: 6px; background: var(--input-bg); border-radius: 999px; overflow: hidden; }
        .task-progress-fill { height: 100%; border-radius: 999px; background: hsl(calc(83 * var(--t, 1)), 75%, calc(var(--fill-l) + var(--fill-ls) * (1 - var(--t, 1)))); transition: width 0.3s ease, --t 0.3s linear; }
        .task-progress-fill.overdue { background: var(--danger); }
        .task-progress-text { font-size: 0.75rem; color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
        .task-progress-text.overdue { color: var(--danger); }
        /* 底部系统信息栏 */
        .footer { text-align: center; padding: 20px; font-size: 0.8rem; color: var(--text-muted); border-top: 1px solid var(--border); }
        .card { background: var(--card-bg); padding: 25px; border-radius: var(--radius); border: 1px solid var(--border); box-shadow: var(--shadow); }
        h2 { margin: 0 0 18px; font-size: 1.2rem; color: var(--text); font-weight: 600; }

        .add-form-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; align-items: end; }
        @media (max-width: 768px) { .add-form-grid { grid-template-columns: 1fr; } }

        .form-group label { display: block; margin-bottom: 6px; font-size: 0.88rem; color: var(--text-secondary); font-weight: 500; }
        .form-group input, .form-group select { width: 100%; padding: 10px 12px; border: 1px solid var(--input-border); border-radius: 9px; background: var(--input-bg); color: var(--text); font-size: 0.92rem; transition: border-color 0.2s, box-shadow 0.2s, background-color 0.2s; }
        .form-group input::placeholder { color: var(--text-muted); }
        .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); background: var(--card-bg); }
        .hint { display: block; margin-top: 6px; font-size: 0.78rem; line-height: 1.5; color: var(--text-muted); }
        .input-row { display: flex; gap: 10px; }
        .input-row > * { min-width: 0; }

        .btn { border: none; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; font-weight: 500; transition: background-color 0.2s, color 0.2s, box-shadow 0.2s, opacity 0.2s, transform 0.1s; white-space: nowrap; }
        .btn:hover:not(:disabled) { filter: brightness(1.05); }
        .btn:active:not(:disabled) { transform: scale(0.98); }
        .btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .btn:focus-visible, .btn-text:focus-visible, .theme-toggle:focus-visible, .login-btn:focus-visible, .logout-btn:focus-visible, .btn-add-trigger:focus-visible, .collapse-header:focus-visible, .trigger-row .btn-remove:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
        .btn-primary { background-color: var(--primary); background-image: linear-gradient(135deg, rgba(255,255,255,0.16), rgba(255,255,255,0)); color: #fff; width: 100%; height: 42px; font-size: 1rem; font-weight: 600; display: flex; align-items: center; justify-content: center; padding: 0 24px; box-shadow: 0 4px 12px rgba(24,144,255,0.22); }
        .btn-action-primary { background-color: var(--success); color: #fff; font-weight: 500; border: 1px solid transparent; padding: 6px 12px; box-shadow: 0 2px 6px rgba(82,196,26,0.22); }
        .btn-action-secondary { background-color: var(--primary-soft); color: var(--primary); border: 1px solid var(--primary-border); font-weight: 500; padding: 6px 12px; }
        .btn-danger { background-color: var(--danger); color: #fff; box-shadow: 0 2px 8px rgba(255,77,79,0.25); }
        .btn.modal-cancel { background: var(--btn-default-bg); color: var(--text); width: 100%; height: 42px; }

        .text-actions { display: flex; gap: 2px; margin-left: 4px; padding-left: 8px; border-left: 1px solid var(--border); }
        .btn-text { background: none; border: none; cursor: pointer; font-size: 0.8rem; padding: 4px 6px; border-radius: 6px; color: var(--text-muted); transition: color 0.2s, background-color 0.2s; white-space: nowrap; }
        .btn-text:hover { background: var(--btn-default-bg); }
        .btn-text.edit:hover { color: var(--primary); }
        .btn-text.copy:hover { color: var(--success); }
        .btn-text.delete:hover { color: var(--danger); }

        .task-list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; align-items: start; }
        @media (max-width: 768px) { .task-list { grid-template-columns: 1fr; } }
        /* 宽屏三列（写在基础规则之后，否则会被覆盖） */
        @media (min-width: 1400px) { .task-list { grid-template-columns: repeat(3, 1fr); } }

        /* 骨架屏 */
        .skeleton-card { background: var(--card-bg); border: 1px solid var(--border); padding: 16px 20px; border-radius: var(--radius); }
        .sk-line { height: 14px; border-radius: 7px; background: linear-gradient(90deg, var(--input-bg) 25%, var(--skeleton-hi) 50%, var(--input-bg) 75%); background-size: 200% 100%; animation: sk-shimmer 1.2s infinite; }
        .sk-line.title { width: 35%; height: 18px; }
        .sk-line.big { width: 25%; height: 26px; margin: 10px auto; }
        .sk-line.bar { width: 100%; height: 8px; margin-top: 14px; }
        @keyframes sk-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

        /* 卡片布局：第一行 名称 + 主操作；第二行 倒计时 + 次级操作；第三行 进度条 */
        .task-item { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto auto auto; align-items: center; gap: 8px 12px; background: var(--card-bg); border: 1px solid var(--border); padding: 15px 20px; border-radius: var(--radius); transition: box-shadow 0.2s, border-color 0.2s, background-color 0.2s, transform 0.2s; }
        @media (hover: hover) {
            .task-item:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); }
            .stat-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); }
        }
        .task-item.important { border-color: var(--warning); background-color: var(--important-bg); }
        .task-item.important::before { content: ''; position: absolute; left: 0; top: 14px; bottom: 14px; width: 3px; border-radius: 0 3px 3px 0; background: var(--warning); }
        .task-item.overdue { border-color: var(--danger); background-color: var(--overdue-bg); }
        .task-item.overdue::before { content: ''; position: absolute; left: 0; top: 14px; bottom: 14px; width: 3px; border-radius: 0 3px 3px 0; background: var(--danger); }

        .task-left { grid-column: 1; grid-row: 1; justify-self: stretch; min-width: 0; font-weight: 600; font-size: 1.05rem; color: var(--text); display: flex; align-items: center; gap: 8px; }
        .task-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .task-actions { grid-column: 2; grid-row: 1; justify-self: end; display: flex; gap: 8px; align-items: center; }
        .task-center { grid-column: 1; grid-row: 2; justify-self: start; text-align: left; }
        .task-text-actions { grid-column: 2; grid-row: 2; justify-self: end; align-self: center; border-left: none; padding-left: 0; margin-left: 0; }
        .task-progress-wrap { grid-column: 1 / -1; grid-row: 3; padding-top: 2px; }
        .countdown-display { font-size: 1.5rem; font-weight: 700; color: var(--success); font-variant-numeric: tabular-nums; letter-spacing: 0.01em; line-height: 1.2; }
        .countdown-display.overdue { color: var(--danger); }
        .countdown-display.due-soon { color: var(--danger); }
        .countdown-display.fresh { color: var(--success); }
        .unit { font-size: 0.9rem; font-weight: 400; margin: 0 4px 0 2px; color: var(--text-muted); }
        /* 长倒计时排版：天数为主、时分秒弱化 */
        .countdown-display .days { font-size: 1.2em; }
        .countdown-display .unit { font-size: 0.85rem; }

        .important-badge { color: var(--warning); font-size: 1rem; flex-shrink: 0; }
        .checked-badge { background: var(--success-bg); color: var(--success-strong); border: 1px solid var(--success-border); font-size: 0.7rem; padding: 1px 8px; border-radius: 999px; font-weight: 600; flex-shrink: 0; }

        /* 空状态 / 加载失败 */
        .task-empty { grid-column: 1 / -1; text-align: center; padding: 56px 20px; color: var(--text-muted); background: var(--card-bg); border: 1px dashed var(--input-border); border-radius: var(--radius); }
        .task-empty-icon { font-size: 2.6rem; margin-bottom: 12px; opacity: 0.85; }
        .task-empty-title { font-size: 1rem; font-weight: 600; color: var(--text-secondary); }
        .task-empty-sub { font-size: 0.85rem; margin-top: 6px; }
        .task-error { grid-column: 1 / -1; text-align: center; padding: 40px 20px; color: var(--danger); background: var(--error-bg); border: 1px solid var(--danger-border); border-radius: var(--radius); }

        .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(15,23,42,0.5); backdrop-filter: blur(2px); justify-content: center; align-items: center; padding: 16px; z-index: 1000; }
        .modal-overlay.visible { display: flex; animation: fadeIn 0.2s ease; }
        .modal-content { background: var(--card-bg); color: var(--text); padding: 24px; border-radius: 16px; width: 420px; max-width: 100%; max-height: 90vh; overflow-y: auto; border: 1px solid var(--border); box-shadow: 0 24px 60px rgba(0,0,0,0.25); animation: popIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1); }
        .modal-content h2 { margin: 0 0 18px; font-size: 1.2rem; }
        .modal-actions { display: flex; gap: 10px; margin-top: 16px; }
        .confirm-modal { width: 360px; }
        .confirm-msg { margin: 0 0 18px; font-size: 0.95rem; line-height: 1.65; color: var(--text-secondary); }
        .confirm-actions { display: flex; gap: 10px; }
        .confirm-actions .btn { flex: 1; height: 40px; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes popIn { from { opacity: 0; transform: scale(0.92) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        .modal-content .form-group { margin-bottom: 15px; }

        /* toast 通知 */
        #toastWrap { position: fixed; right: 16px; bottom: 16px; z-index: 2000; display: flex; flex-direction: column; gap: 10px; align-items: flex-end; pointer-events: none; }
        .toast { pointer-events: auto; background: var(--card-bg); color: var(--text); border: 1px solid var(--border); border-left: 4px solid var(--primary); border-radius: 10px; padding: 12px 16px; font-size: 0.88rem; line-height: 1.5; box-shadow: 0 10px 30px rgba(0,0,0,0.18); animation: toastIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); max-width: min(340px, 80vw); }
        .toast.success { border-left-color: var(--success); }
        .toast.error { border-left-color: var(--danger); }
        .toast.hide { animation: toastOut 0.3s ease forwards; }
        @keyframes toastIn { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes toastOut { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(40px); } }

        .collapse-header { cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 12px; user-select: none; transition: color 0.2s; }
        .collapse-header:hover { color: var(--primary); }
        .collapse-header.locked { cursor: not-allowed; color: var(--text-muted); }
        .collapse-header.locked:hover { color: var(--text-muted); }
        .collapse-arrow { font-size: 1rem; color: var(--text-muted); transition: transform 0.2s; display: inline-block; }
        .collapse-arrow.open { transform: rotate(90deg); }
        .collapse-body { overflow: hidden; transition: max-height 0.3s ease; }

        .top-bar { display: flex; align-items: center; gap: 8px; }
        .theme-toggle { background: var(--btn-default-bg); border: 1px solid var(--border); color: var(--text); width: 36px; height: 36px; border-radius: 10px; cursor: pointer; font-size: 1rem; line-height: 1; transition: background-color 0.2s; }
        .theme-toggle:hover { background: var(--primary-soft); }
        .login-btn { background: var(--primary); color: #fff; padding: 8px 16px; border-radius: 9px; cursor: pointer; font-size: 0.88rem; font-weight: 500; border: none; box-shadow: 0 4px 12px rgba(24,144,255,0.22); transition: filter 0.2s; }
        .login-btn:hover { filter: brightness(1.06); }
        .login-btn.logged-in { background: var(--success); box-shadow: 0 4px 12px rgba(82,196,26,0.22); cursor: default; }
        .logout-btn { background: var(--danger-bg); color: var(--danger); border: 1px solid var(--danger-border); padding: 7px 14px; border-radius: 9px; cursor: pointer; font-size: 0.88rem; font-weight: 500; transition: filter 0.2s; }
        .logout-btn:hover { filter: brightness(0.97); }

        /* 邮件通知设置样式 */
        .trigger-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .trigger-row input { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text); }
        .trigger-row input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
        .trigger-row .unit-label { font-size: 0.82rem; color: var(--text-muted); min-width: 32px; }
        .trigger-row .btn-remove { background: none; border: none; color: var(--danger); cursor: pointer; font-size: 1rem; padding: 4px 8px; border-radius: 6px; line-height: 1; }
        .trigger-row .btn-remove:hover { background: var(--danger-bg); }
        .btn-add-trigger { background: none; border: 1px dashed var(--primary-border); color: var(--primary); padding: 7px 12px; border-radius: 8px; cursor: pointer; font-size: 0.82rem; transition: background-color 0.2s; }
        .btn-add-trigger:hover { background: var(--primary-soft); }
        .email-status { font-size: 0.85rem; color: var(--text-muted); padding: 9px 12px; background: var(--status-bg); border-radius: 8px; margin-top: 5px; min-height: 38px; display: flex; align-items: center; }
        .email-status.success { color: var(--success-strong); background: var(--success-bg); }
        .email-status.error { color: var(--danger); background: var(--error-bg); }
        .inline-group { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
        .inline-group label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 0.9rem; }
        .inline-group input[type="radio"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--primary); }

        /* 移动端适配 */
        @media (max-width: 640px) {
            body { padding: 12px 12px 48px; }
            .app-header { gap: 10px; }
            .brand { gap: 10px; }
            .brand-logo { width: 38px; height: 38px; border-radius: 11px; }
            .page-title { font-size: 1.22rem; }
            .brand-sub { font-size: 0.72rem; }
            .stats-grid { gap: 10px; }
            .stat-card { padding: 12px 13px; gap: 10px; }
            .stat-icon { width: 36px; height: 36px; border-radius: 10px; font-size: 1rem; }
            .stat-value { font-size: 1.4rem; }
            .stat-label { font-size: 0.74rem; }
            .card { padding: 16px; }
            .collapse-header { font-size: 1.05rem; }
            .batch-bar #batchCount { width: 100%; margin-right: 0; }

            /* 任务卡片改为垂直布局 */
            .task-item { display: flex; flex-direction: column; align-items: stretch; gap: 10px; padding: 15px; }
            .task-left { font-size: 1rem; flex-wrap: wrap; }
            .task-name { white-space: normal; word-break: break-word; }
            .task-center { width: 100%; text-align: center; }
            .countdown-display { font-size: 1.35rem; }
            .task-actions { justify-content: center; flex-wrap: wrap; gap: 8px; width: 100%; }
            .task-text-actions { justify-content: center; width: 100%; }
            .text-actions { margin-left: 0; padding-left: 0; border-left: none; }
            .task-progress-wrap { width: 100%; order: 4; }
            .btn { font-size: 0.82rem; padding: 6px 10px; }
            .btn-primary { height: 40px; font-size: 0.95rem; }
            .btn-action-primary, .btn-action-secondary { padding: 6px 12px; }
            .unit { font-size: 0.8rem; }
            #toastWrap { left: 12px; right: 12px; align-items: stretch; }
            .toast { max-width: none; }
        }
        /* 尊重系统"减少动态效果"偏好 */
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
        }
    </style>
</head>
<body>

<div class="layout-container">
    <header class="app-header">
        <div class="brand">
            <img class="brand-logo" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1890ff"/><circle cx="32" cy="32" r="18" fill="none" stroke="#fff" stroke-width="3"/><polyline points="32,22 32,33 40,33" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="38,42 44,48 52,38" fill="none" stroke="#52c41a" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>')}" alt="">
            <div>
                <h1 class="page-title">签到监控看板</h1>
                <p class="brand-sub">Checkin Watcher · 到期自动提醒</p>
            </div>
        </div>
        <div class="top-bar" id="topBar">
            <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="切换深色模式" aria-label="切换深色模式">🌙</button>
            <button class="login-btn" id="loginBtn" onclick="showLogin()">🔐 登录</button>
        </div>
    </header>
    <div class="main-content">
        <div class="stats-grid" id="statsGrid" aria-label="任务统计"></div>
        <div id="batchBar" class="batch-bar" style="display: none;">
            <span id="batchCount">已选 0 项</span>
            <button id="batchCheckinBtn" class="btn btn-action-primary" onclick="batchCheckIn()">✅ 批量签到</button>
            <button id="batchDeleteBtn" class="btn btn-batch-delete" onclick="batchDelete()">🗑 删除所选</button>
            <button id="dueSoonBtn" class="btn btn-action-secondary" onclick="selectDueSoon()">⏰ 选中即将到期</button>
            <button id="clearSelBtn" class="btn btn-ghost" onclick="clearSelection()">清空选择</button>
        </div>
        <div id="tasksList" class="task-list"></div>
    </div>

    <div class="card" id="addCard">
        <h2 id="addSectionHeader" class="collapse-header locked" role="button" tabindex="0" aria-expanded="false" aria-controls="addSectionBody" aria-disabled="true">
            <span id="addTitle">🔒 登录后可添加签到项</span>
            <span id="addSectionArrow" class="collapse-arrow">▶</span>
        </h2>
        <div id="addSectionBody" class="collapse-body" style="max-height: 0;">
            <div class="add-form-grid" style="margin-top: 20px;">
                <div class="form-group">
                    <label>名称</label>
                    <input type="text" id="addName" placeholder="例如：V2EX">
                </div>
                <div class="form-group">
                    <label>签到网址</label>
                    <input type="text" id="addUrl" placeholder="选填，如：v2ex.com">
                </div>
                <div class="form-group">
                    <label>起始时间（选填）</label>
                    <div class="input-row">
                        <input type="date" id="addStartDate" style="flex: 1.5;">
                        <input type="time" id="addStartTime" style="flex: 1;">
                    </div>
                </div>
                <div class="form-group">
                    <label>倒计时周期</label>
                    <div class="input-row">
                        <input type="number" id="addTimeValue" value="1" min="0" step="any" placeholder="可留空" style="flex: 1.5;">
                        <select id="addTimeUnit" style="flex: 1;">
                            <option value="1">小时</option>
                            <option value="24" selected>天</option>
                            <option value="720">月</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label>截止时间（选填）</label>
                    <div class="input-row">
                        <input type="date" id="addDeadlineDate" style="flex: 1.5;">
                        <input type="time" id="addDeadlineTime" style="flex: 1;">
                    </div>
                    <span class="hint">填写后自动计算周期，与周期互相联动</span>
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <label>优先级 (0最低, 100最高)</label>
                    <input type="number" id="addPriority" value="0" min="0" max="100">
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <label>重要程度</label>
                    <select id="addImportance">
                        <option value="normal" selected>正常</option>
                        <option value="important">⭐ 重要</option>
                    </select>
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <label style="display: flex; align-items: center; gap: 8px;">
                        <input type="checkbox" id="addIncludeToday" style="width: 18px; height: 18px; cursor: pointer;">
                        <span>从起始时间开始</span>
                    </label>
                    <span class="hint">默认从第二天0点开始计算周期，勾选后从起始/签到时刻起算</span>
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <button class="btn btn-primary" id="addSubmitBtn" onclick="addTask()">添加</button>
                </div>
            </div>
        </div>
    </div>

    <!-- 邮件通知设置 -->
    <div class="card" id="emailCard">
    <h2 id="emailSectionHeader" class="collapse-header locked" role="button" tabindex="0" aria-expanded="false" aria-controls="emailSectionBody" aria-disabled="true">
        <span id="emailTitle">🔒 登录后可配置邮件通知</span>
        <span id="emailSectionArrow" class="collapse-arrow">▶</span>
    </h2>
    <div id="emailSectionBody" class="collapse-body" style="max-height: 0;">
        <div class="add-form-grid" style="margin-top: 20px;">
            <div class="form-group">
                <label>接收邮箱（多个用逗号分隔）</label>
                <input type="text" id="emailRecipients" placeholder="user@example.com, admin@example.com">
            </div>
            <div class="form-group">
                <label>发件邮箱（需在 Resend 验证）</label>
                <input type="text" id="emailFrom" placeholder="onboarding@resend.dev">
            </div>
            <div class="form-group">
                <label>发送模式</label>
                <div class="inline-group" style="margin-top: 4px;">
                    <label><input type="radio" name="sendMode" value="important" checked> ⭐ 仅重要</label>
                    <label><input type="radio" name="sendMode" value="all"> 📋 全部</label>
                </div>
            </div>
            <div class="form-group" style="grid-column: 1 / -1;">
                <label>发送时机（剩余小时数触发通知，可添加多项）</label>
                <div id="triggerList"></div>
                <button class="btn-add-trigger" onclick="addTriggerRow()">+ 添加触发时间</button>
            </div>
            <div class="form-group" style="margin-bottom: 0;">
                <button class="btn btn-primary" id="emailSaveBtn" onclick="saveEmailSettings()">保存设置</button>
            </div>
            <div class="form-group" style="margin-bottom: 0;">
                <button class="btn btn-action-secondary btn-block" id="emailTestBtn" onclick="testEmail()">测试邮件</button>
            </div>
            <div class="form-group" style="margin-bottom: 0;">
                <div id="emailStatus" class="email-status" style="margin-top: 0;"></div>
            </div>
        </div>
    </div>
</div>
</div>
<div class="footer" id="footerBar">Checkin Watcher v1.0 · 载入中...</div>
<div id="toastWrap"></div>
<!-- 登录弹窗 -->
<div id="loginModal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="loginModalTitle">
    <div class="modal-content">
        <h2 id="loginModalTitle">管理员登录</h2>
        <div class="form-group">
            <label for="loginPassword">密码</label>
            <input type="password" id="loginPassword" placeholder="请输入管理员密码" autocomplete="current-password">
        </div>
        <div class="modal-actions">
            <button class="btn btn-primary" id="loginSubmitBtn" onclick="doLogin()">登录</button>
            <button class="btn modal-cancel" onclick="closeLoginModal()">取消</button>
        </div>
        <p id="loginError" style="color: var(--danger); font-size: 0.9rem; display: none; margin-bottom: 0;"></p>
    </div>
</div>

<div id="editModal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="editModalTitle">
    <div class="modal-content">
        <h2 id="editModalTitle" style="margin-bottom: 15px;">编辑项</h2>
        <input type="hidden" id="editId">
        <div class="form-group">
            <label>名称</label>
            <input type="text" id="editName">
        </div>
        <div class="form-group">
            <label>签到网址</label>
            <input type="text" id="editUrl" placeholder="选填">
        </div>
        <div class="form-group">
            <label>开始时间</label>
            <div class="input-row">
                <input type="date" id="editStartDate" style="flex: 1.5;">
                <input type="time" id="editStartTime" style="flex: 1;">
            </div>
        </div>
        <div class="form-group">
            <label>倒计时周期</label>
            <div class="input-row">
                <input type="number" id="editTimeValue" min="0" step="any" placeholder="可留空" style="flex: 2;">
                <select id="editTimeUnit" style="flex: 1;">
                    <option value="1">小时</option>
                    <option value="24">天</option>
                    <option value="720">月</option>
                </select>
            </div>
        </div>
        <div class="form-group">
            <label>截止时间</label>
            <div class="input-row">
                <input type="date" id="editDeadlineDate" style="flex: 1.5;">
                <input type="time" id="editDeadlineTime" style="flex: 1;">
            </div>
            <span class="hint">填写后自动计算周期，与周期互相联动</span>
        </div>
        <div class="input-row">
            <div class="form-group" style="flex: 1;">
                <label>优先级(0-100)</label>
                <input type="number" id="editPriority" min="0" max="100">
            </div>
            <div class="form-group" style="flex: 1;">
                <label>重要程度</label>
                <select id="editImportance">
                    <option value="normal">正常</option>
                    <option value="important">⭐ 重要</option>
                </select>
            </div>
        </div>
        <div class="form-group">
            <label style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="editIncludeToday" style="width: 18px; height: 18px; cursor: pointer;">
                <span>从起始时间开始</span>
            </label>
            <span class="hint">默认从第二天0点开始计算周期，勾选后从起始/签到时刻起算</span>
        </div>
        <div class="modal-actions">
            <button class="btn btn-primary" id="editSubmitBtn" onclick="saveEdit()">保存</button>
            <button class="btn modal-cancel" onclick="closeEditModal()">取消</button>
        </div>
    </div>
</div>

<script>
    var BASE_URL = window.location.origin;
    var tasks = [];
    var timerInterval = null;
    var authToken = localStorage.getItem('authToken') || null;
    var selectedTasks = new Set();
    var isBatchChecking = false;
    var pendingCheckins = new Set();
    var serverOffset = 0;
    var statsBuilt = false;

    // ===== 通用工具 =====
    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ===== 主题切换 =====
    function applyTheme(theme) {
        var isDark = theme === 'dark';
        document.documentElement.classList.toggle('dark', isDark);
        var btn = document.getElementById('themeToggle');
        if (btn) {
            btn.textContent = isDark ? '☀️' : '🌙';
            btn.title = isDark ? '切换浅色模式' : '切换深色模式';
            btn.setAttribute('aria-label', btn.title);
        }
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', isDark ? '#131417' : '#f0f2f5');
    }

    function toggleTheme() {
        var isDark = document.documentElement.classList.contains('dark');
        var next = isDark ? 'light' : 'dark';
        localStorage.setItem('theme', next);
        applyTheme(next);
    }

    (function initTheme() {
        var saved = localStorage.getItem('theme');
        var sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        applyTheme(saved || (sysDark ? 'dark' : 'light'));
    })();

    // ===== toast 通知 =====
    function showToast(msg, type) {
        var wrap = document.getElementById('toastWrap');
        if (!wrap) return;
        var el = document.createElement('div');
        el.className = 'toast' + (type ? ' ' + type : '');
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        el.textContent = msg;
        wrap.appendChild(el);
        setTimeout(function() {
            el.classList.add('hide');
            setTimeout(function() { el.remove(); }, 300);
        }, 3200);
    }

    // ===== 样式化确认框 =====
    function confirmBox(msg) {
        return new Promise(function(resolve) {
            var overlay = document.createElement('div');
            overlay.className = 'modal-overlay visible';
            overlay.style.zIndex = '1500';
            var content = document.createElement('div');
            content.className = 'modal-content confirm-modal';
            content.innerHTML = '<h2>确认操作</h2>' +
                '<p class="confirm-msg"></p>' +
                '<div class="confirm-actions">' +
                '<button class="btn btn-danger" data-confirm="ok">确定</button>' +
                '<button class="btn modal-cancel" data-confirm="cancel">取消</button></div>';
            content.querySelector('.confirm-msg').textContent = msg;
            overlay.appendChild(content);
            document.body.appendChild(overlay);

            var done = function(val) {
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
                resolve(val);
            };
            var onKey = function(e) {
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    done(false);
                }
            };
            document.addEventListener('keydown', onKey, true);
            content.addEventListener('click', function(e) {
                var b = e.target.closest('[data-confirm]');
                if (!b) return;
                done(b.getAttribute('data-confirm') === 'ok');
            });
            overlay.onclick = function(e) { if (e.target === overlay) done(false); };
            content.querySelector('[data-confirm="ok"]').focus();
        });
    }

    function isTokenExpired() {
        var expiry = localStorage.getItem('authTokenExpiry');
        return expiry && Date.now() > parseInt(expiry);
    }

    function clearAuth() {
        authToken = null;
        localStorage.removeItem('authToken');
        localStorage.removeItem('authTokenExpiry');
    }

    async function verifyToken() {
        if (!authToken) return false;
        // 本地先检查是否过期
        if (isTokenExpired()) {
            clearAuth();
            return false;
        }
        try {
            var res = await fetch(BASE_URL + '/api/verify', {
                headers: { 'Authorization': 'Bearer ' + authToken }
            });
            var data = await res.json();
            if (!data.valid) {
                clearAuth();
                return false;
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    function updateLoginUI() {
        var loginBtn = document.getElementById('loginBtn');
        var topBar = document.getElementById('topBar');
        if (authToken && !isTokenExpired()) {
            loginBtn.textContent = '✅ 已登录';
            loginBtn.className = 'login-btn logged-in';
            loginBtn.onclick = null;
            if (!document.getElementById('logoutBtn')) {
                var logoutBtn = document.createElement('button');
                logoutBtn.id = 'logoutBtn';
                logoutBtn.className = 'logout-btn';
                logoutBtn.textContent = '退出';
                logoutBtn.onclick = doLogout;
                topBar.appendChild(logoutBtn);
            }
            var header = document.getElementById('addSectionHeader');
            header.classList.remove('locked');
            header.setAttribute('aria-disabled', 'false');
            document.getElementById('addTitle').textContent = '➕ 添加签到项';
            // 解锁邮件设置
            var emailHeader = document.getElementById('emailSectionHeader');
            if (emailHeader) {
                emailHeader.classList.remove('locked');
                emailHeader.setAttribute('aria-disabled', 'false');
                document.getElementById('emailTitle').textContent = '📧 邮件通知设置';
            }
        } else {
            loginBtn.textContent = '🔐 登录';
            loginBtn.className = 'login-btn';
            loginBtn.onclick = showLogin;
            var existingLogout = document.getElementById('logoutBtn');
            if (existingLogout) existingLogout.remove();
            // 登出时清理批量选中状态
            selectedTasks.clear();
            isBatchChecking = false;
            var batchBtn = document.getElementById('batchCheckinBtn');
            if (batchBtn) { batchBtn.disabled = false; batchBtn.textContent = '✅ 批量签到'; }
            updateBatchBar();
            var header = document.getElementById('addSectionHeader');
            header.classList.add('locked');
            header.setAttribute('aria-disabled', 'true');
            header.setAttribute('aria-expanded', 'false');
            document.getElementById('addTitle').textContent = '🔒 登录后可添加签到项';
            document.getElementById('addSectionBody').style.maxHeight = '0';
            document.getElementById('addSectionArrow').classList.remove('open');
            // 锁定邮件设置
            var emailHeader = document.getElementById('emailSectionHeader');
            if (emailHeader) {
                emailHeader.classList.add('locked');
                emailHeader.setAttribute('aria-disabled', 'true');
                emailHeader.setAttribute('aria-expanded', 'false');
                document.getElementById('emailTitle').textContent = '🔒 登录后可配置邮件通知';
                document.getElementById('emailSectionBody').style.maxHeight = '0';
                document.getElementById('emailSectionArrow').classList.remove('open');
            }
        }
        loadTasks();
    }

    function showModal(id, focusId) {
        var modal = document.getElementById(id);
        modal.classList.add('visible');
        if (focusId) {
            var el = document.getElementById(focusId);
            if (el) setTimeout(function() { el.focus(); }, 50);
        }
    }

    function hideModal(id) {
        document.getElementById(id).classList.remove('visible');
    }

    // Esc 关闭最上层弹窗
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        var login = document.getElementById('loginModal');
        var edit = document.getElementById('editModal');
        if (edit.classList.contains('visible')) { hideModal('editModal'); return; }
        if (login.classList.contains('visible')) { hideModal('loginModal'); return; }
    });

    // 弹窗内 Enter 提交
    document.getElementById('loginPassword').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') doLogin();
    });
    ['editName', 'editUrl', 'editPriority'].forEach(function(id) {
        document.getElementById(id).addEventListener('keydown', function(e) {
            if (e.key === 'Enter') saveEdit();
        });
    });

    // 任务列表事件委托：不在 HTML 中拼内联 onclick，避免用户输入破坏脚本
    document.getElementById('tasksList').addEventListener('click', function(e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var action = btn.getAttribute('data-action');
        var id = btn.getAttribute('data-id');
        if (action === 'open') openUrl(btn.getAttribute('data-url') || '');
        else if (action === 'checkin') doCheckIn(id);
        else if (action === 'edit') openEditModal(id);
        else if (action === 'copy') copyTask(id);
        else if (action === 'delete') deleteTask(id);
    });
    document.getElementById('tasksList').addEventListener('change', function(e) {
        var cb = e.target.closest('.task-checkbox');
        if (cb) toggleTaskSelection(cb.getAttribute('data-id'));
    });

    function showLogin() {
        showModal('loginModal', 'loginPassword');
        document.getElementById('loginPassword').value = '';
        document.getElementById('loginError').style.display = 'none';
    }

    function closeLoginModal() {
        hideModal('loginModal');
    }

    async function doLogin() {
        var password = document.getElementById('loginPassword').value;
        if (!password) return;
        var errorEl = document.getElementById('loginError');
        var btn = document.getElementById('loginSubmitBtn');
        if (btn) { btn.disabled = true; btn.textContent = '登录中...'; }
        try {
            var res = await fetch(BASE_URL + '/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: password })
            });
            var data = await res.json();
            if (data.success) {
                authToken = data.token;
                localStorage.setItem('authToken', authToken);
                localStorage.setItem('authTokenExpiry', Date.now() + 8 * 60 * 60 * 1000);
                closeLoginModal();
                updateLoginUI();
                showToast('登录成功', 'success');
            } else {
                errorEl.textContent = data.error || '登录失败';
                errorEl.style.display = 'block';
            }
        } catch (e) {
            errorEl.textContent = '网络错误';
            errorEl.style.display = 'block';
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '登录'; }
        }
    }

    async function doLogout() {
        if (authToken) {
            try {
                await fetch(BASE_URL + '/api/logout', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + authToken }
                });
            } catch (e) {}
        }
        authToken = null;
        localStorage.removeItem('authToken');
        localStorage.removeItem('authTokenExpiry');
        updateLoginUI();
        showToast('已退出登录');
    }

    function authFetch(url, options) {
        options = options || {};
        options.headers = options.headers || {};
        if (authToken) {
            options.headers['Authorization'] = 'Bearer ' + authToken;
        }
        return fetch(url, options);
    }

    function openUrl(url) {
        var raw = String(url || '').trim();
        if (!raw) return;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'http://' + raw;
        try {
            var parsed = new URL(raw);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                showToast('仅支持 http/https 链接', 'error');
                return;
            }
            window.open(parsed.href, '_blank', 'noopener,noreferrer');
        } catch (e) {
            showToast('签到网址无效', 'error');
        }
    }

    async function loadTasks() {
        try {
            var res = await fetch(BASE_URL + '/api/tasks', { cache: 'no-store' });
            var data = await res.json();
            tasks = data.tasks || [];
            if (data.serverTime) serverOffset = data.serverTime - Date.now();
            updateFooterServerTime();
            renderTasks();
            startGlobalTimer();
        } catch (e) {
            renderTasksFailed();
        }
    }

    function renderTasksFailed() {
        var batchBar = document.getElementById('batchBar');
        if (batchBar) batchBar.style.display = 'none';
        var container = document.getElementById('tasksList');
        container.innerHTML = '<div class="task-error">⚠️ 加载失败，请检查网络</div>';
    }

    function renderSkeleton() {
        var batchBar = document.getElementById('batchBar');
        if (batchBar) batchBar.style.display = 'none';
        var container = document.getElementById('tasksList');
        var html = '';
        for (var i = 0; i < 4; i++) {
            html += '<div class="skeleton-card"><div class="sk-line title"></div><div class="sk-line big"></div><div class="sk-line bar"></div></div>';
        }
        container.innerHTML = html;
    }

    function sortTasks() {
        var now = Date.now();
        tasks.sort(function(a, b) {
            var diffA = taskDeadline(a) - now;
            var diffB = taskDeadline(b) - now;
            var hoursA = diffA / (1000 * 60 * 60);
            var hoursB = diffB / (1000 * 60 * 60);
            
            var pA = a.priority || 0;
            var pB = b.priority || 0;

            var aImpUrgent = (a.importance === 'important' && hoursA <= 48);
            var bImpUrgent = (b.importance === 'important' && hoursB <= 48);

            if (aImpUrgent && !bImpUrgent) return -1;
            if (!aImpUrgent && bImpUrgent) return 1;
            
            if (aImpUrgent && bImpUrgent) {
                return diffA - diffB;
            }

            var aIn24 = hoursA <= 24;
            var bIn24 = hoursB <= 24;

            if (aIn24 && bIn24) {
                if (pA !== pB) return pB - pA;
                return diffA - diffB; 
            } else if (aIn24 && !bIn24) {
                return -1;
            } else if (!aIn24 && bIn24) {
                return 1;
            } else {
                return diffA - diffB; 
            }
        });
    }

    function getTodayDateString() {
        var d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function renderTasks() {
        var container = document.getElementById('tasksList');
        var batchBar = document.getElementById('batchBar');
        if (batchBar) batchBar.style.display = tasks.length > 0 ? 'flex' : 'none';

        if (tasks.length === 0) {
            container.innerHTML = '<div class="task-empty">' +
                '<div class="task-empty-icon">📋</div>' +
                '<div class="task-empty-title">暂无签到项</div>' +
                '<div class="task-empty-sub">登录后添加第一个签到任务吧</div></div>';
            updateStats();
            return;
        }

        sortTasks();

        // 清理已被删除任务残留的选中状态
        var alive = {};
        tasks.forEach(function(task) { alive[task.id] = true; });
        Array.from(selectedTasks).forEach(function(id) {
            if (!alive[id]) selectedTasks.delete(id);
        });

        var todayStr = getTodayDateString();
        var html = '';
        tasks.forEach(function(task) {
            var isImportant = (task.importance === 'important');
            var checkedToday = (task.checkedDate === todayStr);
            var id = escapeHtml(task.id);
            var name = escapeHtml(task.name);
            var selected = selectedTasks.has(task.id);

            html += '<div class="task-item' + (isImportant ? ' important' : '') + (selected ? ' task-selected' : '') + '" id="task-' + id + '">';

            html += '<div class="task-left" title="' + name + '">';
            html += '<input type="checkbox" class="task-checkbox" data-id="' + id + '" aria-label="选择任务：' + name + '"' + (selected ? ' checked' : '') + '>';
            if (isImportant) html += '<span class="important-badge" title="重要任务">⭐</span>';
            html += '<span class="task-name">' + name + '</span>';
            if (checkedToday) html += '<span class="checked-badge">✓ 已签到</span>';
            html += '</div>';

            html += '<div class="task-center"><div class="countdown-display" id="countdown-' + id + '">--:--:--</div></div>';
            html += '<div class="task-actions">';

            if (task.targetUrl && String(task.targetUrl).trim() !== '') {
                html += '<button class="btn btn-action-primary" data-action="open" data-url="' + escapeHtml(task.targetUrl) + '">去签到</button>';
            }

            html += '<button class="btn btn-action-secondary" data-action="checkin" data-id="' + id + '">我已签到</button>';
            html += '</div>';

            if (authToken) {
                html += '<div class="text-actions task-text-actions">';
                html += '<button class="btn-text edit" data-action="edit" data-id="' + id + '">编辑</button>';
                html += '<button class="btn-text copy" data-action="copy" data-id="' + id + '">复制</button>';
                html += '<button class="btn-text delete" data-action="delete" data-id="' + id + '">删除</button>';
                html += '</div>';
            }
            html += '<div class="task-progress-wrap"><div class="task-progress"><div class="task-progress-bar"><div class="task-progress-fill" id="progress-fill-' + id + '"></div></div><span class="task-progress-text" id="progress-text-' + id + '"></span></div></div>';
            html += '</div>';
        });
        container.innerHTML = html;
        updateCountdowns();
        updateStats();
    }

    function updateStats() {
        var now = Date.now();
        var todayStr = getTodayDateString();
        var total = tasks.length;
        var checkedToday = 0;
        var dueSoon = 0;
        var overdue = 0;

        tasks.forEach(function(task) {
            if (task.checkedDate === todayStr) checkedToday++;
            var diff = taskDeadline(task) - now;
            if (diff <= 0) overdue++;
            else if (diff <= 86400000) dueSoon++;
        });

        var grid = document.getElementById('statsGrid');
        if (!grid) return;
        // 只构建一次 DOM，之后只更新数字，避免每秒重排
        if (!statsBuilt) {
            grid.innerHTML =
                '<div class="stat-card stat-blue"><div class="stat-icon" aria-hidden="true">📋</div><div class="stat-body"><div class="stat-label">总任务</div><div class="stat-value" id="statTotal">0</div></div></div>' +
                '<div class="stat-card stat-green"><div class="stat-icon" aria-hidden="true">✅</div><div class="stat-body"><div class="stat-label">今日签到</div><div class="stat-value" id="statChecked">0</div></div></div>' +
                '<div class="stat-card stat-orange"><div class="stat-icon" aria-hidden="true">⏰</div><div class="stat-body"><div class="stat-label">即将到期</div><div class="stat-value" id="statDueSoon">0</div></div></div>' +
                '<div class="stat-card stat-red"><div class="stat-icon" aria-hidden="true">⚠️</div><div class="stat-body"><div class="stat-label">已逾期</div><div class="stat-value" id="statOverdue">0</div></div></div>';
            statsBuilt = true;
        }
        setStatValue('statTotal', total);
        setStatValue('statChecked', checkedToday);
        setStatValue('statDueSoon', dueSoon);
        setStatValue('statOverdue', overdue);
    }

    function setStatValue(id, value) {
        var el = document.getElementById(id);
        if (el && el.textContent !== String(value)) el.textContent = value;
    }

	    function updateCountdowns() {
        var now = Date.now();
        tasks.forEach(function(task) {
            var deadline = taskDeadline(task);
            var diff = deadline - now;
            var timerEl = document.getElementById('countdown-' + task.id);
            var itemEl = document.getElementById('task-' + task.id);

            if (!timerEl || !itemEl) return;

            if (diff <= 0) {
                timerEl.innerHTML = "⚠️ 已超时";
                timerEl.classList.add('overdue');
                itemEl.classList.add('overdue');
            } else {
                timerEl.classList.remove('overdue');
                itemEl.classList.remove('overdue');

                // 剩余超过一个完整周期：刚签完到，绿色；否则按 24 小时阈值变色
                if (diff >= task.countdownHours * 60 * 60 * 1000) {
                    timerEl.classList.add('fresh');
                    timerEl.classList.remove('due-soon');
                } else if (diff <= 86400000) {
                    timerEl.classList.add('due-soon');
                    timerEl.classList.remove('fresh');
                } else {
                    timerEl.classList.remove('fresh');
                    timerEl.classList.remove('due-soon');
                }

                var days = Math.floor(diff / (1000 * 60 * 60 * 24));
                var hrs = String(Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))).padStart(2, '0');
                var mins = String(Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, '0');
                var secs = String(Math.floor((diff % (1000 * 60)) / 1000)).padStart(2, '0');

                var timeHtml = "";
                if (days > 0) timeHtml += '<span class="days">' + days + '</span><span class="unit">天</span>';
                timeHtml += hrs + '<span class="unit">时</span>' + mins + '<span class="unit">分</span>' + secs + '<span class="unit">秒</span>';
                timerEl.innerHTML = timeHtml;
            }

            // 进度条：剩余时间占比（刚签到=100%，随时间减少，到期=0%）
            var progEl = document.getElementById('progress-fill-' + task.id);
            var progTextEl = document.getElementById('progress-text-' + task.id);
            if (progEl && progTextEl) {
                var totalMs = Math.max(1, task.countdownHours * 60 * 60 * 1000);
                var rawDiff = deadline - now; // 与倒计时同一口径
                var pct = Math.max(0, Math.min(1, rawDiff / totalMs)) * 100;
                progEl.style.width = Math.round(pct) + '%';

                if (rawDiff <= 0) {
                    progEl.style.setProperty('--t', 0);
                    progEl.classList.add('overdue');
                    progTextEl.classList.add('overdue');
                    progTextEl.textContent = '已超时';
                } else {
                    progEl.classList.remove('overdue');
                    progTextEl.classList.remove('overdue');
                    // 平滑渐变：剩余 100% = 绿，0% = 红（--t 1→0，颜色由 CSS 计算）
                    progEl.style.setProperty('--t', (pct / 100).toFixed(3));
                    var deadlineDate = new Date(deadline);
                    var pad = function(n) { return String(n).padStart(2, '0'); };
                    var yearPrefix = deadlineDate.getFullYear() === new Date().getFullYear() ? '' : deadlineDate.getFullYear() + '-';
                    var deadlineStr = yearPrefix + pad(deadlineDate.getMonth() + 1) + '-' + pad(deadlineDate.getDate()) + ' ' + pad(deadlineDate.getHours()) + ':' + pad(deadlineDate.getMinutes());
                    progTextEl.textContent = '截止 ' + deadlineStr;
                }
            }
        });
    }

    function updateFooterServerTime() {
        var el = document.getElementById('footerBar');
        if (!el) return;
        var serverNow = Date.now() + serverOffset;
        var d = new Date(serverNow);
        var pad = function(n) { return String(n).padStart(2, '0'); };
        var str = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        el.textContent = 'Checkin Watcher v1.0 · 服务器时间 ' + str;
    }

    function startGlobalTimer() {
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(function() { updateCountdowns(); updateStats(); updateFooterServerTime(); }, 1000);
    }

    function getStartOfDayMs(ms) {
        var d = new Date(ms);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
    }

    // ===== 起始时间 / 倒计时周期 / 截止时间 三者联动 =====
    // 周期起点 cycleBase：勾选"从起始时间开始"或周期不足一天 → 起始时刻；
    // 否则为起始时间的第二天0点（起始本身是0点则不变）。截止时间 = cycleBase + 周期。
    function cycleBaseMs(startMs, includeToday, hours) {
        if (includeToday) return startMs;
        if (!isFinite(hours) || hours < 24) return startMs;
        if (getStartOfDayMs(startMs) === startMs) return startMs;
        var d = new Date(startMs);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
    }

    // 由截止时间反推周期小时数，与 cycleBaseMs 的取整规则保持自洽：
    // 未勾选时优先按"第二天0点"为基准反推（要求结果 ≥ 24h），否则按起始时刻为基准
    function hoursFromDeadline(startMs, deadlineMs, includeToday) {
        if (includeToday) return deadlineMs > startMs ? (deadlineMs - startMs) / 3600000 : null;
        var midnight = cycleBaseMs(startMs, false, 24);
        var h = (deadlineMs - midnight) / 3600000;
        if (deadlineMs > midnight && h >= 24) return h;
        return deadlineMs > startMs ? (deadlineMs - startMs) / 3600000 : null;
    }

    function calcDeadlineFromStart(startMs, hours, includeToday) {
        if (!isFinite(hours) || hours <= 0) return null;
        return cycleBaseMs(startMs, includeToday, hours) + hours * 3600000;
    }

    // 前端倒计时口径，与后端 taskDeadline 一致
    function taskDeadline(task) {
        var base = (typeof task.cycleBase === 'number') ? task.cycleBase : task.lastCheckIn;
        return base + task.countdownHours * 60 * 60 * 1000;
    }

    function pickUnit(hours) {
        if (hours >= 720 && hours % 720 === 0) return { value: hours / 720, unit: '720' };
        if (hours >= 24 && hours % 24 === 0) return { value: hours / 24, unit: '24' };
        return { value: hours, unit: '1' };
    }

    // 从周期输入读取小时数；周期留空返回 null（由截止时间反推）
    function readCycleHours(valueElId, unitElId) {
        var v = parseFloat(document.getElementById(valueElId).value);
        var u = parseFloat(document.getElementById(unitElId).value);
        if (isNaN(v) || v <= 0) return null;
        return v * u;
    }

    // 从截止时间输入读取时间戳；未填返回 null
    function readDeadlineMs(dateElId, timeElId) {
        var dateStr = document.getElementById(dateElId).value;
        var timeStr = document.getElementById(timeElId).value;
        if (!dateStr) return null;
        var t = new Date(dateStr + 'T' + (timeStr || '00:00'));
        return isNaN(t.getTime()) ? null : t.getTime();
    }

    function setDeadlineInputs(dateElId, timeElId, ms) {
        if (ms == null) {
            document.getElementById(dateElId).value = '';
            document.getElementById(timeElId).value = '';
            return;
        }
        var d = new Date(ms);
        document.getElementById(dateElId).value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        document.getElementById(timeElId).value = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    function setCycleInputs(valueElId, unitElId, hours) {
        var p = pickUnit(hours);
        document.getElementById(valueElId).value = p.value;
        document.getElementById(unitElId).value = p.unit;
    }

    // 折叠面板：展开状态由 DOM 的 .open 决定，避免登出后状态错乱
    function bindCollapse(headerId, bodyId, arrowId, onOpen) {
        var header = document.getElementById(headerId);
        var body = document.getElementById(bodyId);
        var arrow = document.getElementById(arrowId);
        function setOpen(open) {
            body.style.maxHeight = open ? body.scrollHeight + 'px' : '0';
            arrow.classList.toggle('open', open);
            header.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        function toggle() {
            if (!authToken) {
                showToast('请先登录管理员账号', 'error');
                return;
            }
            var willOpen = !arrow.classList.contains('open');
            if (willOpen && onOpen) {
                Promise.resolve(onOpen()).then(function() { setOpen(true); }, function() { setOpen(true); });
            } else {
                setOpen(willOpen);
            }
        }
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            }
        });
    }

    // 触发时间行增减后重新计算折叠面板高度，避免内容被裁切
    function refreshEmailBodyHeight() {
        var body = document.getElementById('emailSectionBody');
        var arrow = document.getElementById('emailSectionArrow');
        if (body && arrow && arrow.classList.contains('open')) {
            body.style.maxHeight = body.scrollHeight + 'px';
        }
    }

    bindCollapse('addSectionHeader', 'addSectionBody', 'addSectionArrow');
    bindCollapse('emailSectionHeader', 'emailSectionBody', 'emailSectionArrow', loadEmailSettings);

    // 添加表单联动：改周期 → 重算截止；改截止 → 反推周期
    (function() {
        var cycleIds = ['addTimeValue', 'addTimeUnit'];
        var editing = false;
        cycleIds.forEach(function(id) {
            document.getElementById(id).addEventListener('input', function() {
                if (editing) return;
                editing = true;
                var hours = readCycleHours('addTimeValue', 'addTimeUnit');
                var startMs = readDeadlineMs('addStartDate', 'addStartTime') || Date.now();
                var includeToday = document.getElementById('addIncludeToday').checked;
                setDeadlineInputs('addDeadlineDate', 'addDeadlineTime', calcDeadlineFromStart(startMs, hours, includeToday));
                editing = false;
            });
        });
        ['addDeadlineDate', 'addDeadlineTime'].forEach(function(id) {
            document.getElementById(id).addEventListener('input', function() {
                if (editing) return;
                editing = true;
                var deadlineMs = readDeadlineMs('addDeadlineDate', 'addDeadlineTime');
                var startMs = readDeadlineMs('addStartDate', 'addStartTime') || Date.now();
                var includeToday = document.getElementById('addIncludeToday').checked;
                if (deadlineMs == null) {
                    // 清空截止时间时恢复默认周期 1 天
                    setCycleInputs('addTimeValue', 'addTimeUnit', 24);
                } else if (deadlineMs > startMs) {
                    var h = hoursFromDeadline(startMs, deadlineMs, includeToday);
                    if (h != null) setCycleInputs('addTimeValue', 'addTimeUnit', h);
                }
                editing = false;
            });
        });
        document.getElementById('addStartDate').addEventListener('input', recalcAddDeadline);
        document.getElementById('addStartTime').addEventListener('input', recalcAddDeadline);
        document.getElementById('addIncludeToday').addEventListener('change', recalcAddDeadline);
        function recalcAddDeadline() {
            var hours = readCycleHours('addTimeValue', 'addTimeUnit');
            if (hours == null) return;
            var startMs = readDeadlineMs('addStartDate', 'addStartTime') || Date.now();
            setDeadlineInputs('addDeadlineDate', 'addDeadlineTime', calcDeadlineFromStart(startMs, hours, document.getElementById('addIncludeToday').checked));
        }
    })();

    async function addTask() {
        if (!authToken) {
            showToast('请先登录', 'error');
            return;
        }
        var name = document.getElementById('addName').value.trim();
        var targetUrl = document.getElementById('addUrl').value.trim();
        var priority = document.getElementById('addPriority').value;
        var importance = document.getElementById('addImportance').value;
        var includeToday = document.getElementById('addIncludeToday').checked;

        if (!name) return showToast('请填写名称', 'error');

        // 周期与截止时间联动：周期留空时由截止时间反推
        var countdownHours = readCycleHours('addTimeValue', 'addTimeUnit');
        var deadlineMs = readDeadlineMs('addDeadlineDate', 'addDeadlineTime');

        var startDateStr = document.getElementById('addStartDate').value;
        var startTimeStr = document.getElementById('addStartTime').value;
        var lastCheckIn;
        if (startDateStr && startTimeStr) {
            lastCheckIn = new Date(startDateStr + 'T' + startTimeStr).getTime();
        } else if (startDateStr) {
            // 只填日期不填时间：视为当天 0 点
            lastCheckIn = new Date(startDateStr + 'T00:00').getTime();
        } else {
            lastCheckIn = Date.now();
        }

        if (countdownHours == null && deadlineMs == null) {
            countdownHours = 24; // 两者都未填时默认 1 天
        } else if (countdownHours == null) {
            countdownHours = hoursFromDeadline(lastCheckIn, deadlineMs, includeToday);
            if (countdownHours == null) return showToast('截止时间必须晚于起始时间', 'error');
        }
        deadlineMs = calcDeadlineFromStart(lastCheckIn, countdownHours, includeToday);

        var unit;
        if (countdownHours % 720 === 0) unit = 'months';
        else if (countdownHours % 24 === 0) unit = 'days';
        else unit = 'hours';

        var addBtn = document.getElementById('addSubmitBtn');
        if (addBtn) { addBtn.disabled = true; addBtn.textContent = '添加中...'; }
        try {
            var res = await authFetch(BASE_URL + '/api/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name, targetUrl: targetUrl, countdownHours: countdownHours,
                    priority: priority, importance: importance,
                    unit: unit,
                    lastCheckIn: lastCheckIn,
                    cycleBase: cycleBaseMs(lastCheckIn, includeToday, countdownHours),
                    includeToday: includeToday
                })
            });
            if (res.ok) {
                document.getElementById('addName').value = '';
                document.getElementById('addUrl').value = '';
                document.getElementById('addPriority').value = '0';
                document.getElementById('addImportance').value = 'normal';
                document.getElementById('addIncludeToday').checked = false;
                document.getElementById('addStartDate').value = '';
                document.getElementById('addStartTime').value = '';
                document.getElementById('addTimeValue').value = '1';
                document.getElementById('addTimeUnit').value = '24';
                document.getElementById('addDeadlineDate').value = '';
                document.getElementById('addDeadlineTime').value = '';
                showToast('已添加「' + name + '」', 'success');
                loadTasks();
            } else if (res.status === 401) {
                showToast('登录已过期，请重新登录', 'error');
                doLogout();
            } else {
                showToast('添加失败，请稍后重试', 'error');
            }
        } catch (e) {
            showToast('网络错误，添加失败', 'error');
        } finally {
            if (addBtn) { addBtn.disabled = false; addBtn.textContent = '添加'; }
        }
    }

    function doCheckIn(id) {
        var task = tasks.find(function(t) { return t.id === id; });
        if (!task) return;

        // lastCheckIn 记录真实签到时刻；周期起点按勾选规则计算（未勾选整天周期=第二天0点）
        var now = Date.now();
        sendCheckIn(id, now, cycleBaseMs(now, task.includeToday || false, task.countdownHours));
    }

    async function sendCheckIn(id, lastCheckIn, cycleBase) {
        if (pendingCheckins.has(id)) return;
        pendingCheckins.add(id);
        try {
            var res = await fetch(BASE_URL + '/api/checkin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: id,
                    lastCheckIn: lastCheckIn,
                    cycleBase: cycleBase,
                    checkedDate: getTodayDateString()
                })
            });

            if (res.ok) {
                fireConfetti(60);
                showToast('签到成功，倒计时已重置', 'success');
                setTimeout(loadTasks, 300);
            } else {
                showToast('签到失败，请稍后重试', 'error');
            }
        } catch (e) {
            showToast('网络错误，签到失败', 'error');
        } finally {
            pendingCheckins.delete(id);
        }
    }

    function toggleTaskSelection(id) {
        if (isBatchChecking) return;
        setTaskSelection(id, !selectedTasks.has(id));
        updateBatchBar();
    }

    function updateBatchBar() {
        var countEl = document.getElementById('batchCount');
        if (!countEl) return;
        countEl.textContent = '已选 ' + selectedTasks.size + ' 项';
        var checkinBtn = document.getElementById('batchCheckinBtn');
        var deleteBtn = document.getElementById('batchDeleteBtn');
        var has = selectedTasks.size > 0;
        if (checkinBtn) checkinBtn.disabled = !has || isBatchChecking;
        if (deleteBtn) deleteBtn.disabled = !has || isBatchChecking;
    }

    function fireConfetti(particleCount) {
        try {
            if (typeof confetti === 'function') {
                confetti({ particleCount: particleCount, spread: 70, origin: { y: 0.8 } });
            }
        } catch (e) {}
    }

    function setTaskSelection(id, selected) {
        if (selected) selectedTasks.add(id); else selectedTasks.delete(id);
        var itemEl = document.getElementById('task-' + id);
        if (itemEl) itemEl.classList.toggle('task-selected', selected);
        var checkbox = itemEl ? itemEl.querySelector('.task-checkbox') : null;
        if (checkbox) checkbox.checked = selected;
    }

    function selectDueSoon() {
        if (isBatchChecking) return;
        var now = Date.now();
        tasks.forEach(function(task) {
            // 与倒计时显示一致的截止时间口径
            var deadline = taskDeadline(task);
            var diff = deadline - now;
            if (diff > 0 && diff <= 86400000) setTaskSelection(task.id, true);
        });
        updateBatchBar();
    }

    function clearSelection() {
        if (isBatchChecking) return;
        tasks.forEach(function(task) { setTaskSelection(task.id, false); });
        updateBatchBar();
    }

    async function batchDelete() {
        if (isBatchChecking || selectedTasks.size === 0) return;
        if (!authToken) {
            showToast('请先登录', 'error');
            return;
        }
        if (!(await confirmBox('确定删除选中的 ' + selectedTasks.size + ' 项吗？删除后不可恢复！'))) return;

        isBatchChecking = true;
        var ids = Array.from(selectedTasks);
        var success = 0;
        var fail = 0;
        var btn = document.getElementById('batchDeleteBtn');
        if (btn) { btn.disabled = true; btn.textContent = '删除中...'; }

        try {
            for (var i = 0; i < ids.length; i++) {
                try {
                    var res = await authFetch(BASE_URL + '/api/delete?id=' + encodeURIComponent(ids[i]), { method: 'POST' });
                    if (res.ok) { success++; } else { fail++; }
                } catch (e) { fail++; }
            }
        } finally {
            selectedTasks.clear();
            isBatchChecking = false;
            if (btn) { btn.disabled = false; btn.textContent = '🗑 删除所选'; }
        }

        await loadTasks();
        updateBatchBar();

        if (fail > 0) {
            showToast('批量删除完成：成功 ' + success + ' 项，失败 ' + fail + ' 项', 'error');
        } else if (success > 0) {
            showToast('已删除 ' + success + ' 项', 'success');
        }
    }

    async function batchCheckIn() {
        if (isBatchChecking || selectedTasks.size === 0) return;
        isBatchChecking = true;
        var ids = Array.from(selectedTasks);
        var success = 0;
        var fail = 0;
        var btn = document.getElementById('batchCheckinBtn');
        if (btn) { btn.disabled = true; btn.textContent = '签到中...'; }

        try {
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                var task = tasks.find(function(t) { return t.id === id; });
                if (!task) continue;
                var now = Date.now();
                try {
                    var res = await fetch(BASE_URL + '/api/checkin', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            id: id,
                            lastCheckIn: now,
                            cycleBase: cycleBaseMs(now, task.includeToday || false, task.countdownHours),
                            checkedDate: getTodayDateString()
                        })
                    });
                    if (res.ok) { success++; } else { fail++; }
                } catch (e) { fail++; }
            }
        } finally {
            selectedTasks.clear();
            isBatchChecking = false;
            if (btn) { btn.disabled = false; btn.textContent = '✅ 批量签到'; }
        }

        if (success > 0) {
            fireConfetti(Math.min(60 + success * 10, 200));
        }

        await loadTasks();
        updateBatchBar();

        if (fail > 0) {
            showToast('批量签到完成：成功 ' + success + ' 项，失败 ' + fail + ' 项', 'error');
        } else if (success > 0) {
            showToast('已签到 ' + success + ' 项', 'success');
        }
    }

    async function deleteTask(id) {
        if (!authToken) {
            showToast('请先登录', 'error');
            return;
        }
        if (!(await confirmBox('确定删除该项吗？'))) return;
        try {
            var res = await authFetch(BASE_URL + '/api/delete?id=' + encodeURIComponent(id), { method: 'POST' });
            if (res.ok) {
                showToast('已删除', 'success');
                loadTasks();
            } else if (res.status === 401) {
                showToast('登录已过期，请重新登录', 'error');
                doLogout();
            } else {
                showToast('删除失败，请稍后重试', 'error');
            }
        } catch (e) {
            showToast('网络错误，删除失败', 'error');
        }
    }

    async function copyTask(id) {
        if (!authToken) {
            showToast('请先登录', 'error');
            return;
        }
        var task = tasks.find(function(t) { return t.id === id; });
        if (!task) return;

        try {
            var res = await authFetch(BASE_URL + '/api/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: task.name + ' - 副本',
                    targetUrl: task.targetUrl || '',
                    countdownHours: task.countdownHours,
                    priority: task.priority || 0,
                    importance: task.importance || 'normal',
                    unit: task.unit || 'hours',
                    lastCheckIn: task.lastCheckIn,
                    cycleBase: typeof task.cycleBase === 'number' ? task.cycleBase : task.lastCheckIn,
                    includeToday: task.includeToday || false
                })
            });
            if (res.ok) {
                showToast('已复制任务', 'success');
                loadTasks();
            } else if (res.status === 401) {
                showToast('登录已过期，请重新登录', 'error');
                doLogout();
            } else {
                showToast('复制失败，请稍后重试', 'error');
            }
        } catch (e) {
            showToast('网络错误，复制失败', 'error');
        }
    }

    function openEditModal(id) {
        if (!authToken) return;
        var task = tasks.find(function(t) { return t.id === id; });
        if (!task) return;
        
        document.getElementById('editId').value = task.id;
        document.getElementById('editName').value = task.name;
        document.getElementById('editUrl').value = task.targetUrl || "";
        document.getElementById('editPriority').value = task.priority || 0;
        document.getElementById('editImportance').value = task.importance || 'normal';
        document.getElementById('editIncludeToday').checked = task.includeToday || false;

        var startDate = new Date(task.lastCheckIn);
        var dateStr = startDate.getFullYear() + '-' + String(startDate.getMonth() + 1).padStart(2, '0') + '-' + String(startDate.getDate()).padStart(2, '0');
        var timeStr = String(startDate.getHours()).padStart(2, '0') + ':' + String(startDate.getMinutes()).padStart(2, '0');
        document.getElementById('editStartDate').value = dateStr;
        document.getElementById('editStartTime').value = timeStr;

        var hours = task.countdownHours;
        setCycleInputs('editTimeValue', 'editTimeUnit', hours);
        setDeadlineInputs('editDeadlineDate', 'editDeadlineTime', taskDeadline(task));

        document.getElementById('editModal').classList.add('visible');
    }

    function closeEditModal() {
        hideModal('editModal');
    }

    // 编辑弹窗联动：改周期 → 重算截止；改截止 → 反推周期（以弹窗内起始时间为基准）
    (function() {
        var editing = false;
        ['editTimeValue', 'editTimeUnit'].forEach(function(id) {
            document.getElementById(id).addEventListener('input', function() {
                if (editing) return;
                editing = true;
                var hours = readCycleHours('editTimeValue', 'editTimeUnit');
                var startMs = readDeadlineMs('editStartDate', 'editStartTime');
                var includeToday = document.getElementById('editIncludeToday').checked;
                setDeadlineInputs('editDeadlineDate', 'editDeadlineTime',
                    hours == null ? null : calcDeadlineFromStart(startMs, hours, includeToday));
                editing = false;
            });
        });
        ['editDeadlineDate', 'editDeadlineTime'].forEach(function(id) {
            document.getElementById(id).addEventListener('input', function() {
                if (editing) return;
                editing = true;
                var deadlineMs = readDeadlineMs('editDeadlineDate', 'editDeadlineTime');
                var startMs = readDeadlineMs('editStartDate', 'editStartTime');
                var includeToday = document.getElementById('editIncludeToday').checked;
                if (deadlineMs == null) {
                    setCycleInputs('editTimeValue', 'editTimeUnit', 24);
                } else if (deadlineMs > startMs) {
                    var h = hoursFromDeadline(startMs, deadlineMs, includeToday);
                    if (h != null) setCycleInputs('editTimeValue', 'editTimeUnit', h);
                }
                editing = false;
            });
        });
        ['editStartDate', 'editStartTime', 'editIncludeToday'].forEach(function(id) {
            document.getElementById(id).addEventListener('input', recalcEditDeadline);
            document.getElementById(id).addEventListener('change', recalcEditDeadline);
        });
        function recalcEditDeadline() {
            var hours = readCycleHours('editTimeValue', 'editTimeUnit');
            if (hours == null) return;
            var startMs = readDeadlineMs('editStartDate', 'editStartTime');
            setDeadlineInputs('editDeadlineDate', 'editDeadlineTime',
                calcDeadlineFromStart(startMs, hours, document.getElementById('editIncludeToday').checked));
        }
    })();

    async function saveEdit() {
        var id = document.getElementById('editId').value;
        var name = document.getElementById('editName').value.trim();
        var targetUrl = document.getElementById('editUrl').value.trim();
        var priority = document.getElementById('editPriority').value;
        var importance = document.getElementById('editImportance').value;
        var includeToday = document.getElementById('editIncludeToday').checked;

        var startDateStr = document.getElementById('editStartDate').value;
        var startTimeStr = document.getElementById('editStartTime').value;

        if (!name) return showToast('名称不能为空', 'error');
        if (!startDateStr || !startTimeStr) return showToast('请选择开始时间', 'error');

        // 周期与截止时间联动：周期留空时由截止时间反推
        var newLastCheckIn = new Date(startDateStr + 'T' + startTimeStr).getTime();
        var countdownHours = readCycleHours('editTimeValue', 'editTimeUnit');
        var deadlineMs = readDeadlineMs('editDeadlineDate', 'editDeadlineTime');
        if (countdownHours == null && deadlineMs == null) {
            return showToast('请填写倒计时周期或截止时间', 'error');
        } else if (countdownHours == null) {
            countdownHours = hoursFromDeadline(newLastCheckIn, deadlineMs, includeToday);
            if (countdownHours == null) return showToast('截止时间必须晚于起始时间', 'error');
        }

        var unit;
        if (countdownHours % 720 === 0) unit = 'months';
        else if (countdownHours % 24 === 0) unit = 'days';
        else unit = 'hours';

        var task = tasks.find(function(t) { return t.id === id; });
        var startTimeChanged = task && Math.floor(task.lastCheckIn / 60000) !== Math.floor(newLastCheckIn / 60000);

        var editData = {
            id: id, name: name, targetUrl: targetUrl, countdownHours: countdownHours,
            priority: priority, importance: importance,
            unit: unit,
            includeToday: includeToday,
            lastCheckIn: newLastCheckIn,
            cycleBase: cycleBaseMs(newLastCheckIn, includeToday, countdownHours)
        };

        if (startTimeChanged) {
            editData.checkedDate = null;
        }

        try {
            var res = await authFetch(BASE_URL + '/api/edit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editData)
            });

            if (res.ok) {
                closeEditModal();
                showToast('已保存修改', 'success');
                loadTasks();
            } else if (res.status === 401) {
                showToast('登录已过期，请重新登录', 'error');
                doLogout();
            } else {
                showToast('保存失败，请稍后重试', 'error');
            }
        } catch (e) {
            showToast('网络错误，保存失败', 'error');
        }
    }

    // ===== 邮件通知设置功能 =====
    var emailTriggerCount = 0;

    function addTriggerRow(value) {
        emailTriggerCount++;
        var container = document.getElementById('triggerList');
        var div = document.createElement('div');
        div.className = 'trigger-row';
        div.id = 'trigger-row-' + emailTriggerCount;
        div.innerHTML = '<input type="number" id="trigger-input-' + emailTriggerCount + '" value="' + escapeHtml(value == null ? '' : value) + '" min="1" placeholder="例如：24（小时）" aria-label="触发时间（小时）">' +
            '<span class="unit-label">小时</span>' +
            '<button class="btn-remove" type="button" onclick="removeTriggerRow(this)" aria-label="删除该触发时间">✕</button>';
        container.appendChild(div);
        refreshEmailBodyHeight();
    }

    function removeTriggerRow(btn) {
        btn.parentElement.remove();
        refreshEmailBodyHeight();
    }

    function getTriggersFromUI() {
        var inputs = document.querySelectorAll('#triggerList .trigger-row input');
        var triggers = [];
        inputs.forEach(function(inp) {
            var val = parseFloat(inp.value);
            if (!isNaN(val) && val > 0) triggers.push(val);
        });
        triggers.sort(function(a, b) { return b - a; });
        return triggers;
    }

    function setTriggersToUI(triggers) {
        document.getElementById('triggerList').innerHTML = '';
        emailTriggerCount = 0;
        if (triggers && triggers.length > 0) {
            triggers.forEach(function(t) { addTriggerRow(t); });
        } else {
            addTriggerRow(24);
        }
        refreshEmailBodyHeight();
    }

    function setEmailStatus(text, type) {
        var el = document.getElementById('emailStatus');
        if (!el) return;
        el.textContent = text;
        el.className = 'email-status' + (type ? ' ' + type : '');
    }

    async function loadEmailSettings() {
        try {
            var res = await authFetch(BASE_URL + '/api/email-settings');
            if (!res.ok) return;
            var data = await res.json();
            if (!data.success) return;
            var s = data.settings;
            document.getElementById('emailRecipients').value = (s.recipients || []).join(', ');
            document.getElementById('emailFrom').value = s.fromEmail || 'onboarding@resend.dev';
            setTriggersToUI(s.triggers);
            var modeRadios = document.getElementsByName('sendMode');
            for (var i = 0; i < modeRadios.length; i++) {
                if (modeRadios[i].value === s.sendMode) modeRadios[i].checked = true;
            }
            setEmailStatus('');
            refreshEmailBodyHeight();
        } catch (e) {
            console.error('加载邮件设置失败', e);
        }
    }

    async function saveEmailSettings() {
        if (!authToken) { showToast('请先登录', 'error'); return; }
        var recipientsStr = document.getElementById('emailRecipients').value.trim();
        var recipients = recipientsStr.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
        if (recipients.length === 0) {
            setEmailStatus('⚠️ 请至少填写一个接收邮箱', 'error');
            return;
        }
        var triggers = getTriggersFromUI();
        if (triggers.length === 0) {
            setEmailStatus('⚠️ 请至少添加一个触发时间', 'error');
            return;
        }
        var sendMode = document.querySelector('input[name="sendMode"]:checked').value;
        var fromEmail = document.getElementById('emailFrom').value.trim() || 'onboarding@resend.dev';

        var btn = document.getElementById('emailSaveBtn');
        if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
        try {
            var res = await authFetch(BASE_URL + '/api/email-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipients: recipients, triggers: triggers, sendMode: sendMode, fromEmail: fromEmail })
            });
            var data = await res.json();
            if (data.success) {
                setEmailStatus('✅ 设置已保存', 'success');
                showToast('邮件设置已保存', 'success');
            } else {
                setEmailStatus('⚠️ 保存失败', 'error');
            }
        } catch (e) {
            setEmailStatus('⚠️ 网络错误，保存失败', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '保存设置'; }
        }
    }

    async function testEmail() {
        if (!authToken) { showToast('请先登录', 'error'); return; }
        setEmailStatus('⏳ 正在发送测试邮件...');
        var btn = document.getElementById('emailTestBtn');
        if (btn) { btn.disabled = true; btn.textContent = '发送中...'; }
        try {
            var res = await authFetch(BASE_URL + '/api/test-email', { method: 'POST' });
            var data = await res.json();
            if (data.success) {
                setEmailStatus('✅ 测试邮件发送成功，请检查收件箱', 'success');
            } else {
                setEmailStatus('⚠️ 发送失败，请检查 Resend API 配置', 'error');
            }
        } catch (e) {
            setEmailStatus('⚠️ 网络错误', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '测试邮件'; }
        }
    }

    (async function() {
        renderSkeleton();
        await verifyToken();
        updateLoginUI();
    })();
</script>
</body>
</html>`;
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer'
        }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};