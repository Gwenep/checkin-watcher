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

function createEmailHtml(task, remainingMs) {
  const deadline = new Date(task.lastCheckIn + (task.countdownHours * 60 * 60 * 1000));
  const remaining = formatRemainingTime(remainingMs);
  const importanceLabel = task.importance === 'important' ? '⭐ 重要' : '普通';
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1890ff;">⏰ 签到提醒</h2>
      <div style="background: #f0f5ff; border-radius: 8px; padding: 20px; margin: 15px 0;">
        <p style="font-size: 16px; margin: 8px 0;"><strong>任务：</strong>${task.name}</p>
        <p style="font-size: 16px; margin: 8px 0;"><strong>重要程度：</strong>${importanceLabel}</p>
        <p style="font-size: 20px; color: #ff4d4f; margin: 12px 0;"><strong>剩余时间：${remaining}</strong></p>
        <p style="font-size: 14px; color: #666; margin: 8px 0;">截止时间：${deadline.toLocaleString('zh-CN')}</p>
        ${task.targetUrl ? `<p style="margin: 12px 0;"><a href="${task.targetUrl}" style="display: inline-block; background: #52c41a; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none;">去签到</a></p>` : ''}
      </div>
      <p style="color: #999; font-size: 12px;">此邮件由签到监控系统自动发送</p>
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

    const deadline = task.lastCheckIn + (task.countdownHours * 60 * 60 * 1000);
    const remaining = deadline - now;

    let closestTrigger = null, closestKey = null, closestTriggerMs = Infinity;
    for (const trigger of settings.triggers) {
      const key = `${task.id}_${task.lastCheckIn}_${trigger}`;
      if (sentNotifications[key]) continue;
      const triggerMs = trigger * 60 * 60 * 1000;
      if (remaining > 0 && remaining <= triggerMs && triggerMs < closestTriggerMs) {
        closestTriggerMs = triggerMs;
        closestTrigger = trigger;
        closestKey = key;
      }
    }
    if (closestTrigger) {
      notificationsToSend.push({ task, remaining, trigger: closestTrigger, key: closestKey });
    }
  }

  for (const n of notificationsToSend) {
    const subject = `⏰ 签到提醒：${n.task.name} - 还剩 ${formatRemainingTime(n.remaining)}`;
    const html = createEmailHtml(n.task, n.remaining);
    const ok = await sendEmail(env, settings, subject, html);
    if (ok) {
      sentNotifications[n.key] = now;
      newSent = true;
    }
  }

  if (newSent) {
    settings.sentNotifications = sentNotifications;
    await KV.put("email_settings", JSON.stringify(settings));
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
      try {
        const body = await request.json();
        const password = body.password || "";
        if (password !== env.ADMIN_PASSWORD) {
          return new Response(JSON.stringify({ success: false, error: "密码错误" }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }
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
      
      const newTask = {
        id: body.id || Date.now().toString(),
        name: body.name || "未命名任务",
        targetUrl: typeof body.targetUrl === 'string' ? body.targetUrl : "",
        countdownHours: parseFloat(body.countdownHours) || 24,
        priority: Math.min(100, Math.max(0, parseInt(body.priority) || 0)),
        importance: body.importance === 'important' ? 'important' : 'normal',
        unit: body.unit || 'hours',
        lastCheckIn: body.lastCheckIn || Date.now(),
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
            name: body.name,
            targetUrl: typeof body.targetUrl === 'string' ? body.targetUrl : "",
            countdownHours: parseFloat(body.countdownHours) || 24,
            priority: Math.min(100, Math.max(0, parseInt(body.priority) || 0)),
            importance: body.importance === 'important' ? 'important' : 'normal',
            unit: body.unit || task.unit || 'hours',
            includeToday: body.includeToday || false,
            lastCheckIn: body.lastCheckIn !== undefined ? body.lastCheckIn : task.lastCheckIn,
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
      const checkedDate = body.checkedDate;
      
      if (!taskId) {
        return new Response(JSON.stringify({ success: false, error: "缺少 id" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      let tasks = await getTasks(KV);
      tasks = tasks.map(task => {
        if (task.id === taskId) {
          return { 
            ...task, 
            lastCheckIn: newLastCheckIn || Date.now(),
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
    <title>签到监控看板</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1890ff"/><circle cx="32" cy="32" r="18" fill="none" stroke="#fff" stroke-width="3"/><polyline points="32,22 32,33 40,33" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="38,42 44,48 52,38" fill="none" stroke="#52c41a" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>')}">
    <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js"></script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f0f2f5; margin: 0; padding: 20px 20px 40px 20px; color: #333; }
        .layout-container { display: flex; flex-direction: column; gap: 24px; max-width: 920px; margin: 0 auto; }
        /* 统计面板 */
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 6px; }
        .stat-card { background: #fff; border-radius: 12px; padding: 16px 18px; box-shadow: 0 2px 10px rgba(0,0,0,0.04); }
        .stat-card .stat-label { font-size: 0.85rem; color: #888; margin-bottom: 8px; }
        .stat-card .stat-value { font-size: 2rem; font-weight: 700; color: #2c3e50; font-variant-numeric: tabular-nums; }
        .stat-card .stat-value.stat-blue { color: #1890ff; }
        .stat-card .stat-value.stat-green { color: #52c41a; }
        .stat-card .stat-value.stat-orange { color: #faad14; }
        .stat-card .stat-value.stat-red { color: #ff4d4f; }
        @media (max-width: 768px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } }
        /* 任务进度条 */
        .task-progress-wrap { grid-column: 1 / -1; }
        .task-progress { display: flex; align-items: center; gap: 10px; }
        .task-progress-bar { flex: 1; height: 6px; background: #f0f0f0; border-radius: 3px; overflow: hidden; }
        .task-progress-fill { height: 100%; border-radius: 3px; background: #52c41a; transition: width 0.3s ease; }
        .task-progress-fill.warn { background: #faad14; }
        .task-progress-fill.danger { background: #ff4d4f; }
        .task-progress-text { font-size: 0.75rem; color: #999; white-space: nowrap; }
        /* 底部系统信息栏 */
        .footer { text-align: center; padding: 20px; font-size: 0.8rem; color: #aaa; border-top: 1px solid #eee; }
        .card { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.04); }
        h2 { margin-top: 0; font-size: 1.4rem; color: #1a1a1a; margin-bottom: 20px; font-weight: 600; }
        .page-title { text-align: center; font-size: 1.8rem; margin-bottom: 18px; color: #2c3e50; }
        .page-title img { height: 1.6rem; vertical-align: middle; margin-right: 8px; }
        
        .add-form-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; align-items: flex-end; }
        @media (max-width: 768px) { .add-form-grid { grid-template-columns: 1fr; } }
        
        .form-group label { display: block; margin-bottom: 6px; font-size: 0.9rem; color: #666; }
        .form-group input, .form-group select { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; background: #fafafa; }
        .form-group input:focus, .form-group select:focus { outline: none; border-color: #3498db; }
        .input-row { display: flex; gap: 10px; }
        
        .btn { box-sizing: border-box; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; transition: all 0.2s; white-space: nowrap; }
        .btn:hover { opacity: 0.85; }
        .btn-primary { background-color: #1890ff; color: white; width: 100%; height: 42px; font-size: 1rem; font-weight: 500; display: flex; align-items: center; justify-content: center; padding: 0 24px; }
        .btn-action-primary { background-color: #52c41a; color: white; font-weight: 500; border: 1px solid transparent; } 
        .btn-action-secondary { background-color: #f0f5ff; color: #1890ff; border: 1px solid #adc6ff; font-weight: 500; } 
        
        .text-actions { display: flex; gap: 4px; margin-left: 10px; padding-left: 14px; border-left: 1px solid #e8e8e8; }
        .btn-text { background: none; border: none; cursor: pointer; font-size: 0.85rem; padding: 6px 8px; color: #999; transition: color 0.2s; }
        .btn-text.edit:hover { color: #1890ff; }
        .btn-text.delete:hover { color: #ff4d4f; }
        
        .task-list { display: flex; flex-direction: column; gap: 15px; }
        
        /* 桌面端：三列网格 */
        .task-item { display: grid; grid-template-columns: 1fr auto 1fr; grid-template-rows: auto auto; align-items: center; gap: 6px 0; background: #fff; border: 1px solid #eee; padding: 16px 25px; border-radius: 12px; transition: box-shadow 0.2s; }
        .task-item:hover { box-shadow: 0 4px 15px rgba(0,0,0,0.06); }
        .task-item.important { border-color: #faad14; background-color: #fffbe6; box-shadow: 0 2px 8px rgba(250, 173, 20, 0.15); }
        .task-item.overdue { border-color: #ff4d4f; background-color: #fff2f0; box-shadow: none; }

        .task-left { grid-row: 1; justify-self: start; font-weight: 600; font-size: 1.15rem; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; display: flex; align-items: center; gap: 8px; }
        .task-center { grid-row: 1; justify-self: center; text-align: center; }
        .task-right { grid-row: 1; justify-self: end; display: flex; gap: 8px; align-items: center; }
        .task-progress-wrap { grid-column: 1 / -1; grid-row: 2; padding-top: 2px; }
        .countdown-display { font-size: 1.6rem; font-weight: 700; color: #52c41a; font-variant-numeric: tabular-nums; }
        .countdown-display.overdue { color: #ff4d4f; }
        .unit { font-size: 0.9rem; font-weight: 400; margin: 0 4px 0 2px; color: #888; }
        
        .important-badge { color: #faad14; font-size: 1rem; }
        .checked-badge { background: #52c41a; color: white; font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
        
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
        .modal-content { background: white; padding: 25px; border-radius: 12px; width: 400px; max-width: 90%; }
        .modal-content .form-group { margin-bottom: 15px; }
        
        .collapse-header { cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; }
        .collapse-header:hover { color: #1890ff; }
        .collapse-header.locked { cursor: not-allowed; color: #999; }
        .collapse-arrow { font-size: 1.2rem; transition: transform 0.2s; display: inline-block; }
        .collapse-arrow.open { transform: rotate(90deg); }
        .collapse-body { overflow: hidden; transition: max-height 0.3s ease; }
        
        .top-bar { display: flex; justify-content: flex-end; align-items: center; margin-bottom: 10px; }
        .login-btn { background: #1890ff; color: white; padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; border: none; }
        .login-btn.logged-in { background: #52c41a; }
        .logout-btn { background: #ff4d4f; color: white; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; border: none; margin-left: 8px; }

        /* 邮件通知设置样式 */
        .trigger-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .trigger-row input { flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 6px; background: #fafafa; }
        .trigger-row input:focus { outline: none; border-color: #3498db; }
        .trigger-row .btn-remove { background: none; border: none; color: #ff4d4f; cursor: pointer; font-size: 1.2rem; padding: 4px 8px; }
        .trigger-row .btn-remove:hover { opacity: 0.7; }
        .btn-add-trigger { background: none; border: 1px dashed #1890ff; color: #1890ff; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
        .btn-add-trigger:hover { background: #f0f5ff; }
        .email-status { font-size: 0.85rem; color: #999; padding: 8px 12px; background: #f9f9f9; border-radius: 6px; margin-top: 5px; }
        .email-status.success { color: #52c41a; background: #f6ffed; }
        .email-status.error { color: #ff4d4f; background: #fff2f0; }
        .inline-group { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        .inline-group label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 0.9rem; }
        .inline-group input[type="radio"] { width: 16px; height: 16px; cursor: pointer; }

        /* 移动端适配 */
        @media (max-width: 600px) {
            body { padding: 10px 10px 60px 10px; }
            .page-title { font-size: 1.5rem; margin-bottom: 20px; }
            .page-title img { height: 1.4rem; }
            .card { padding: 15px; }
            
            /* 任务卡片改为垂直布局 */
            .task-item { 
                display: flex; 
                flex-direction: column; 
                gap: 12px; 
                padding: 15px; 
            }
            .task-left { 
                font-size: 1rem; 
                white-space: normal; 
                word-break: break-word; 
                display: flex; 
                flex-wrap: wrap;
                align-items: center;
            }
            .task-center { 
                text-align: center;   /* 倒计时居中 */
                width: 100%; 
            }
            .countdown-display { 
                font-size: 1.3rem; 
            }
            .task-right { 
                display: flex; 
                flex-wrap: wrap; 
                gap: 8px; 
                justify-content: center;   /* 按钮组居中 */
                width: 100%; 
            }
            .text-actions {
                margin-left: 0;
                padding-left: 0;
                border-left: none;
            }
            .task-progress-wrap {
                grid-column: auto;
                grid-row: auto;
                width: 100%;
                order: 4;
            }
            .btn {
                font-size: 0.8rem;
                padding: 6px 10px;
            }
            .btn-primary { 
                height: 38px; 
                font-size: 0.9rem; 
            }
            .btn-action-primary, .btn-action-secondary { 
                padding: 6px 12px; 
            }
            .unit { 
                font-size: 0.8rem; 
            }
        }
    </style>
</head>
<body>

<div class="top-bar" id="topBar">
    <button class="login-btn" id="loginBtn" onclick="showLogin()">🔐 登录</button>
</div>

<div class="layout-container">
    <div class="main-content">
        <h2 class="page-title"><img src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1890ff"/><circle cx="32" cy="32" r="18" fill="none" stroke="#fff" stroke-width="3"/><polyline points="32,22 32,33 40,33" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="38,42 44,48 52,38" fill="none" stroke="#52c41a" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>')}" style="height:1.6rem;vertical-align:middle;margin-right:8px;" alt=""> 签到监控看板</h2>
        <div class="stats-grid" id="statsGrid"></div>
        <div id="tasksList" class="task-list">加载中...</div>
    </div>

    <div class="card" id="addCard">
        <h2 id="addSectionHeader" class="collapse-header locked">
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
                        <input type="number" id="addTimeValue" value="1" min="1" step="1" style="flex: 1.5;">
                        <select id="addTimeUnit" style="flex: 1;">
                            <option value="1">小时</option>
                            <option value="24" selected>天</option>
                            <option value="720">月</option>
                        </select>
                    </div>
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
                        <span>包含今天</span>
                    </label>
                    <span style="font-size: 0.8rem; color: #999;">默认否，选是则1天倒计时从签到时间起算</span>
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <button class="btn btn-primary" onclick="addTask()">添加</button>
                </div>
            </div>
        </div>
    </div>

    <!-- 邮件通知设置 -->
    <div class="card" id="emailCard">
    <h2 id="emailSectionHeader" class="collapse-header locked">
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
                <button class="btn btn-primary" onclick="saveEmailSettings()">保存设置</button>
            </div>
            <div class="form-group" style="margin-bottom: 0;">
                <button class="btn btn-action-secondary" onclick="testEmail()" style="width:100%;">测试邮件</button>
            </div>
            <div class="form-group" style="margin-bottom: 0;">
                <div id="emailStatus" class="email-status" style="margin-top: 0;"></div>
            </div>
        </div>
    </div>
</div>
</div>
<div class="footer" id="footerBar">Checkin Watcher v1.0 · 载入中...</div>
<!-- 登录弹窗 -->
<div id="loginModal" class="modal-overlay">
    <div class="modal-content">
        <h2>管理员登录</h2>
        <div class="form-group">
            <label>密码</label>
            <input type="password" id="loginPassword" placeholder="请输入管理员密码">
        </div>
        <div style="display: flex; gap: 10px; margin-top: 10px;">
            <button class="btn btn-primary" onclick="doLogin()">登录</button>
            <button class="btn" style="background:#f0f0f0; width:100%; color:#333; height:42px;" onclick="closeLoginModal()">取消</button>
        </div>
        <p id="loginError" style="color: red; font-size: 0.9rem; display: none;"></p>
    </div>
</div>

<div id="editModal" class="modal-overlay">
    <div class="modal-content">
        <h2 style="margin-bottom: 15px;">编辑项</h2>
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
                <input type="number" id="editTimeValue" min="1" step="1" style="flex: 2;">
                <select id="editTimeUnit" style="flex: 1;">
                    <option value="1">小时</option>
                    <option value="24">天</option>
                    <option value="720">月</option>
                </select>
            </div>
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
                <span>包含今天</span>
            </label>
        </div>
        <div style="display: flex; gap: 10px; margin-top: 10px;">
            <button class="btn btn-primary" onclick="saveEdit()">保存</button>
            <button class="btn" style="background:#f0f0f0; width:100%; color:#333; height:42px;" onclick="closeEditModal()">取消</button>
        </div>
    </div>
</div>

<script>
    var BASE_URL = window.location.origin;
    var tasks = [];
    var timerInterval = null;
    var authToken = localStorage.getItem('authToken') || null;

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
            header.style.cursor = 'pointer';
            document.getElementById('addTitle').textContent = '➕ 添加签到项';
            // 解锁邮件设置
            var emailHeader = document.getElementById('emailSectionHeader');
            if (emailHeader) {
                emailHeader.classList.remove('locked');
                emailHeader.style.cursor = 'pointer';
                document.getElementById('emailTitle').textContent = '📧 邮件通知设置';
            }
        } else {
            loginBtn.textContent = '🔐 登录';
            loginBtn.className = 'login-btn';
            loginBtn.onclick = showLogin;
            var existingLogout = document.getElementById('logoutBtn');
            if (existingLogout) existingLogout.remove();
            var header = document.getElementById('addSectionHeader');
            header.classList.add('locked');
            header.style.cursor = 'not-allowed';
            document.getElementById('addTitle').textContent = '🔒 登录后可添加签到项';
            document.getElementById('addSectionBody').style.maxHeight = '0';
            document.getElementById('addSectionArrow').classList.remove('open');
            // 锁定邮件设置
            var emailHeader = document.getElementById('emailSectionHeader');
            if (emailHeader) {
                emailHeader.classList.add('locked');
                emailHeader.style.cursor = 'not-allowed';
                document.getElementById('emailTitle').textContent = '🔒 登录后可配置邮件通知';
                document.getElementById('emailSectionBody').style.maxHeight = '0';
                document.getElementById('emailSectionArrow').classList.remove('open');
            }
        }
        loadTasks();
    }

    function showLogin() {
        document.getElementById('loginModal').style.display = 'flex';
        document.getElementById('loginPassword').value = '';
        document.getElementById('loginError').style.display = 'none';
    }

    function closeLoginModal() {
        document.getElementById('loginModal').style.display = 'none';
    }

    async function doLogin() {
        var password = document.getElementById('loginPassword').value;
        if (!password) return;
        var errorEl = document.getElementById('loginError');
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
            } else {
                errorEl.textContent = data.error || '登录失败';
                errorEl.style.display = 'block';
            }
        } catch (e) {
            errorEl.textContent = '网络错误';
            errorEl.style.display = 'block';
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
        var finalUrl = url.trim();
        if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
            finalUrl = 'http://' + finalUrl;
        }
        window.open(finalUrl, '_blank');
    }

    async function loadTasks() {
        try {
            var res = await fetch(BASE_URL + '/api/tasks');
            var data = await res.json();
            tasks = data.tasks || [];
            if (data.serverTime) { serverOffset = data.serverTime - Date.now(); }
            updateFooterServerTime();
            renderTasks();
            startGlobalTimer();
        } catch (e) {
            document.getElementById('tasksList').innerText = "加载失败，请检查网络";
        }
    }

    function sortTasks() {
        var now = Date.now();
        tasks.sort(function(a, b) {
            var diffA = (a.lastCheckIn + (a.countdownHours * 60 * 60 * 1000)) - now;
            var diffB = (b.lastCheckIn + (b.countdownHours * 60 * 60 * 1000)) - now;
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
        if (tasks.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding: 40px; color:#888; background:#fff; border-radius:12px;">暂无签到项，请在下方添加。</div>';
            return;
        }
        
        sortTasks();
        
        var todayStr = getTodayDateString();
        container.innerHTML = '';
        tasks.forEach(function(task) {
            var isImportant = (task.importance === 'important');
            var checkedToday = (task.checkedDate === todayStr);
            
            var html = '<div class="task-item ' + (isImportant ? 'important' : '') + '" id="task-' + task.id + '">';
            
            html += '<div class="task-left" title="' + task.name + '">';
            if (isImportant) html += '<span class="important-badge">⭐</span>';
            html += '<span>' + task.name + '</span>';
            if (checkedToday) html += '<span class="checked-badge">✓ 已签到</span>';
            html += '</div>';

            html += '<div class="task-center"><div class="countdown-display" id="countdown-' + task.id + '">--:--:--</div></div>';
            html += '<div class="task-right">';
            
            if (task.targetUrl && task.targetUrl.trim() !== '') {
                html += '<button class="btn btn-action-primary" onclick="openUrl(\\'' + task.targetUrl + '\\')">去签到</button>';
            }
            
            html += '<button class="btn btn-action-secondary" onclick="doCheckIn(\\'' + task.id + '\\')">我已签到</button>';
            
            if (authToken) {
                html += '<div class="text-actions">';
                html += '<button class="btn-text edit" onclick="openEditModal(\\'' + task.id + '\\')">编辑</button>';
                html += '<button class="btn-text delete" onclick="deleteTask(\\'' + task.id + '\\')">删除</button>';
                html += '</div>';
            }
            html += '</div>';
            html += '<div class="task-progress-wrap"><div class="task-progress" id="progress-' + task.id + '"><div class="task-progress-bar"><div class="task-progress-fill" id="progress-fill-' + task.id + '"></div></div><span class="task-progress-text" id="progress-text-' + task.id + '"></span></div></div>';
            html += '</div>';
            
            container.insertAdjacentHTML('beforeend', html);
        });
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
	            var deadline = task.lastCheckIn + (task.countdownHours * 60 * 60 * 1000);
	            var diff = deadline - now;
	            if (diff <= 0) overdue++;
	            else if (diff <= 86400000) dueSoon++;
	        });

	        var grid = document.getElementById('statsGrid');
	        if (!grid) return;
	        grid.innerHTML =
	            '<div class="stat-card"><div class="stat-label">📋 总任务</div><div class="stat-value stat-blue">' + total + '</div></div>' +
	            '<div class="stat-card"><div class="stat-label">✅ 今日签到</div><div class="stat-value stat-green">' + checkedToday + '</div></div>' +
	            '<div class="stat-card"><div class="stat-label">⏰ 即将到期</div><div class="stat-value stat-orange">' + dueSoon + '</div></div>' +
	            '<div class="stat-card"><div class="stat-label">⚠️ 已逾期</div><div class="stat-value stat-red">' + overdue + '</div></div>';
	    }

	    function updateCountdowns() {
	        var now = Date.now();
	        tasks.forEach(function(task) {
            var deadline = task.lastCheckIn + (task.countdownHours * 60 * 60 * 1000);
            var diff = deadline - now;
            var timerEl = document.getElementById('countdown-' + task.id);
            var itemEl = document.getElementById('task-' + task.id);

            if (!timerEl || !itemEl) return;

            // 进度条用的截止时间，随 includeToday 逻辑同步调整
            var progDeadline = deadline;

            if (task.unit !== 'hours') {
                if (task.includeToday) {
                    // 包含今天：倒计时从签到时间起算，剩余不超过完整周期
                    diff = Math.min(diff, task.countdownHours * 60 * 60 * 1000);
                } else {
                    // 不包含今天：检查起始时间是否在午夜（false签到时设为午夜）
                    var checkinDate = new Date(task.lastCheckIn);
                    var isMidnight = checkinDate.getHours() === 0 && checkinDate.getMinutes() === 0;
                    if (!isMidnight && diff > 0) {
                        // 起始时间不是午夜（原本是true签到后切到false）
                        // 用签到当天的午夜+周期作为截止时间
                        var midnight = new Date(checkinDate.getFullYear(), checkinDate.getMonth(), checkinDate.getDate() + 1, 0, 0, 0, 0).getTime();
                        var falseDeadline = midnight + task.countdownHours * 60 * 60 * 1000;
                        diff = Math.max(diff, falseDeadline - now);
                        progDeadline = falseDeadline;
                    }
                }
            }

            if (diff <= 0) {
                timerEl.innerHTML = "⚠️ 已超时";
                timerEl.classList.add('overdue');
                itemEl.classList.add('overdue');
                timerEl.style.color = ''; // 恢复CSS中的红色
            } else {
                timerEl.classList.remove('overdue');
                itemEl.classList.remove('overdue');
                
                // 24小时内（86400000毫秒）显示红色
                if (diff <= 86400000) {
                    timerEl.style.color = '#ff4d4f';
                } else {
                    timerEl.style.color = '#52c41a';
                }
                
                var days = Math.floor(diff / (1000 * 60 * 60 * 24));
                var hrs = String(Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))).padStart(2, '0');
                var mins = String(Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, '0');
                var secs = String(Math.floor((diff % (1000 * 60)) / 1000)).padStart(2, '0');
                
                var timeHtml = "";
                if (days > 0) timeHtml += days + '<span class="unit">天</span>';
                timeHtml += hrs + '<span class="unit">时</span>' + mins + '<span class="unit">分</span>' + secs + '<span class="unit">秒</span>';
                timerEl.innerHTML = timeHtml;
            }

            // 进度条：剩余时间占比（刚签到=100%，随时间减少，到期=0%）
            var progEl = document.getElementById('progress-fill-' + task.id);
            var progTextEl = document.getElementById('progress-text-' + task.id);
            if (progEl && progTextEl) {
                var totalMs = task.countdownHours * 60 * 60 * 1000;
                var rawDiff = progDeadline - now; // 用 progDeadline 计算，与倒计时逻辑一致
                var pct = Math.max(0, Math.min(1, rawDiff / totalMs)) * 100;
                progEl.style.width = Math.round(pct) + '%';

                if (rawDiff <= 0) {
                    progEl.classList.add('danger');
                    progEl.classList.remove('warn');
                    progTextEl.textContent = '已超时';
                } else if (pct <= 20) {
                    progEl.classList.add('danger');
                    progEl.classList.remove('warn');
                    progTextEl.textContent = '剩余 ' + Math.max(1, Math.ceil(rawDiff / 3600000)) + ' 小时';
                } else if (pct <= 50) {
                    progEl.classList.add('warn');
                    progEl.classList.remove('danger');
                    progTextEl.textContent = '剩余 ' + Math.max(1, Math.ceil(rawDiff / 3600000)) + ' 小时';
                } else {
                    progEl.classList.remove('warn', 'danger');
                    var daysLeft = Math.floor(rawDiff / 86400000);
                    var hoursLeft = Math.floor((rawDiff % 86400000) / 3600000);
                    progTextEl.textContent = (daysLeft > 0 ? daysLeft + ' 天 ' + hoursLeft + ' 小时' : hoursLeft + ' 小时');
                }
            }
        });
    }

    var serverOffset = 0;

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

    function getLocalEndOfDay() {
        var now = new Date();
        var end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
        return end.getTime();
    }

    (function() {
        var header = document.getElementById('addSectionHeader');
        var body = document.getElementById('addSectionBody');
        var arrow = document.getElementById('addSectionArrow');
        var isOpen = false;
        
        header.addEventListener('click', function() {
            if (!authToken) {
                alert('请先登录管理员账号');
                return;
            }
            isOpen = !isOpen;
            if (isOpen) {
                body.style.maxHeight = body.scrollHeight + 'px';
                arrow.classList.add('open');
            } else {
                body.style.maxHeight = '0';
                arrow.classList.remove('open');
            }
        });
    })();

    (function() {
        var header = document.getElementById('emailSectionHeader');
        var body = document.getElementById('emailSectionBody');
        var arrow = document.getElementById('emailSectionArrow');
        var isOpen = false;

        header.addEventListener('click', function() {
            if (!authToken) {
                alert('请先登录管理员账号');
                return;
            }
            isOpen = !isOpen;
            if (isOpen) {
                arrow.classList.add('open');
                (async () => {
                    await loadEmailSettings();
                    body.style.maxHeight = body.scrollHeight + 'px';
                })();
            } else {
                body.style.maxHeight = '0';
                arrow.classList.remove('open');
            }
        });
    })();

    async function addTask() {
        if (!authToken) {
            alert('请先登录');
            return;
        }
        var name = document.getElementById('addName').value.trim();
        var targetUrl = document.getElementById('addUrl').value.trim();
        var timeValue = parseFloat(document.getElementById('addTimeValue').value);
        var timeUnit = parseFloat(document.getElementById('addTimeUnit').value);
        var priority = document.getElementById('addPriority').value;
        var importance = document.getElementById('addImportance').value;
        var includeToday = document.getElementById('addIncludeToday').checked;

        if (!name) return alert('请填写名称');
        
        var countdownHours = timeValue * timeUnit;
        var unit = (timeUnit === 1) ? 'hours' : ((timeUnit === 24) ? 'days' : 'months');
        
        var startDateStr = document.getElementById('addStartDate').value;
        var startTimeStr = document.getElementById('addStartTime').value;
        var lastCheckIn;
        if (startDateStr && startTimeStr) {
            lastCheckIn = new Date(startDateStr + 'T' + startTimeStr).getTime();
        } else {
            lastCheckIn = Date.now();
        }

        var res = await authFetch(BASE_URL + '/api/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                name: name, targetUrl: targetUrl, countdownHours: countdownHours, 
                priority: priority, importance: importance,
                unit: unit,
                lastCheckIn: lastCheckIn,
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
            loadTasks();
        } else if (res.status === 401) {
            alert('登录已过期，请重新登录');
            doLogout();
        }
    }

    async function doCheckIn(id) {
        var task = tasks.find(function(t) { return t.id === id; });
        if (!task) return;

        var unit = task.unit || 'hours';
        var includeToday = task.includeToday || false;
        var newLastCheckIn = (includeToday || unit === 'hours') ? Date.now() : getLocalEndOfDay();
        var checkedDate = getTodayDateString();

        var res = await fetch(BASE_URL + '/api/checkin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                id: id,
                lastCheckIn: newLastCheckIn,
                checkedDate: checkedDate
            })
        });
        
        if (res.ok) {
            confetti({ particleCount: 60, spread: 70, origin: { y: 0.8 } });
            setTimeout(loadTasks, 300);
        } else {
            alert('签到失败，请稍后重试');
        }
    }

    async function deleteTask(id) {
        if (!authToken) {
            alert('请先登录');
            return;
        }
        if(!confirm('确定删除该项吗？')) return;
        var res = await authFetch(BASE_URL + '/api/delete?id=' + id, { method: 'POST' });
        if (res.ok) {
            loadTasks();
        } else if (res.status === 401) {
            alert('登录已过期，请重新登录');
            doLogout();
        }
    }

    function openEditModal(id) {
        if (!authToken) return;
        var task = tasks.find(function(t) { return t.id === id; });
        if(!task) return;
        
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
        if (hours % 720 === 0) {
            document.getElementById('editTimeValue').value = hours / 720;
            document.getElementById('editTimeUnit').value = "720";
        } else if (hours % 24 === 0) {
            document.getElementById('editTimeValue').value = hours / 24;
            document.getElementById('editTimeUnit').value = "24";
        } else {
            document.getElementById('editTimeValue').value = hours;
            document.getElementById('editTimeUnit').value = "1";
        }

        document.getElementById('editModal').style.display = 'flex';
    }

    function closeEditModal() {
        document.getElementById('editModal').style.display = 'none';
    }

    async function saveEdit() {
        var id = document.getElementById('editId').value;
        var name = document.getElementById('editName').value.trim();
        var targetUrl = document.getElementById('editUrl').value.trim();
        var timeValue = parseFloat(document.getElementById('editTimeValue').value);
        var timeUnit = parseFloat(document.getElementById('editTimeUnit').value);
        var priority = document.getElementById('editPriority').value;
        var importance = document.getElementById('editImportance').value;
        var includeToday = document.getElementById('editIncludeToday').checked;
        
        var startDateStr = document.getElementById('editStartDate').value;
        var startTimeStr = document.getElementById('editStartTime').value;

        if (!name) return alert('名称不能为空');
        if (!startDateStr || !startTimeStr) return alert('请选择开始时间');
        
        var countdownHours = timeValue * timeUnit;
        var unit = (timeUnit === 1) ? 'hours' : ((timeUnit === 24) ? 'days' : 'months');
        
        var startDateTime = new Date(startDateStr + 'T' + startTimeStr);
        var newLastCheckIn = startDateTime.getTime();

        var task = tasks.find(function(t) { return t.id === id; });
        var startTimeChanged = task && Math.floor(task.lastCheckIn / 60000) !== Math.floor(newLastCheckIn / 60000);

        var editData = { 
            id: id, name: name, targetUrl: targetUrl, countdownHours: countdownHours,
            priority: priority, importance: importance,
            unit: unit,
            includeToday: includeToday,
            lastCheckIn: newLastCheckIn
        };

        if (startTimeChanged) {
            editData.checkedDate = null;
        }

        var res = await authFetch(BASE_URL + '/api/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(editData)
        });
        
        if (res.ok) {
            closeEditModal();
            loadTasks();
        } else if (res.status === 401) {
            alert('登录已过期，请重新登录');
            doLogout();
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
        div.innerHTML = '<input type="number" id="trigger-input-' + emailTriggerCount + '" value="' + (value || '') + '" min="1" placeholder="例如：24（小时）" style="flex:1;">' +
            '<span style="font-size:0.85rem;color:#666;min-width:40px;">小时</span>' +
            '<button class="btn-remove" onclick="removeTriggerRow(this)">✕</button>';
        container.appendChild(div);
    }

    function removeTriggerRow(btn) {
        btn.parentElement.remove();
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
            document.getElementById('emailStatus').textContent = '';
            document.getElementById('emailStatus').className = 'email-status';
        } catch (e) {
            console.error('加载邮件设置失败', e);
        }
    }

    async function saveEmailSettings() {
        if (!authToken) { alert('请先登录'); return; }
        var recipientsStr = document.getElementById('emailRecipients').value.trim();
        var recipients = recipientsStr.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
        if (recipients.length === 0) {
            document.getElementById('emailStatus').textContent = '⚠️ 请至少填写一个接收邮箱';
            document.getElementById('emailStatus').className = 'email-status error';
            return;
        }
        var triggers = getTriggersFromUI();
        if (triggers.length === 0) {
            document.getElementById('emailStatus').textContent = '⚠️ 请至少添加一个触发时间';
            document.getElementById('emailStatus').className = 'email-status error';
            return;
        }
        var sendMode = document.querySelector('input[name="sendMode"]:checked').value;
        var fromEmail = document.getElementById('emailFrom').value.trim() || 'onboarding@resend.dev';

        var res = await authFetch(BASE_URL + '/api/email-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipients: recipients, triggers: triggers, sendMode: sendMode, fromEmail: fromEmail })
        });
        var data = await res.json();
        if (data.success) {
            document.getElementById('emailStatus').textContent = '✅ 设置已保存';
            document.getElementById('emailStatus').className = 'email-status success';
        } else {
            document.getElementById('emailStatus').textContent = '⚠️ 保存失败';
            document.getElementById('emailStatus').className = 'email-status error';
        }
    }

    async function testEmail() {
        if (!authToken) { alert('请先登录'); return; }
        document.getElementById('emailStatus').textContent = '⏳ 正在发送测试邮件...';
        document.getElementById('emailStatus').className = 'email-status';
        try {
            var res = await authFetch(BASE_URL + '/api/test-email', { method: 'POST' });
            var data = await res.json();
            if (data.success) {
                document.getElementById('emailStatus').textContent = '✅ 测试邮件发送成功，请检查收件箱';
                document.getElementById('emailStatus').className = 'email-status success';
            } else {
                document.getElementById('emailStatus').textContent = '⚠️ 发送失败，请检查 Resend API 配置';
                document.getElementById('emailStatus').className = 'email-status error';
            }
        } catch (e) {
            document.getElementById('emailStatus').textContent = '⚠️ 网络错误';
            document.getElementById('emailStatus').className = 'email-status error';
        }
    }

    (async function() {
        await verifyToken();
        updateLoginUI();
        loadTasks();
    })();
</script>
</body>
</html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response("Not Found", { status: 404 });
  }
};