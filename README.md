# Check-in Watcher (签到提醒器)

一个基于 **Cloudflare Workers** 的签到提醒工具，帮助团队或个人跟踪定期签到任务，并在到期前通过邮件发送提醒通知。

## 📋 功能特性

- **任务管理** — 创建、编辑、删除签到任务，自定义任务名称、截止周期、优先级和重要性
- **签到系统** — 一键签到，自动重置截止倒计时，可选今日已签到标记
- **智能排序** — 任务按紧急程度智能排序：重要且紧急的优先，24小时内到期的优先，同优先级按剩余时间排序
- **实时倒计时** — 每个任务显示实时倒计时（天/时/分），过期自动变红
- **邮件通知** — 通过 Resend API 发送提醒邮件，支持自定义触发时间点（如 24h、12h、6h、1h 前）
- **通知模式** — 支持「仅重要任务」和「全部任务」两种通知模式
- **管理员认证** — 管理员密码登录，保护任务编辑和删除操作
- **响应式设计** — 适配桌面和移动端
- **持久化存储** — 使用 Cloudflare KV 存储数据

## 🚀 快速开始

### 1. 部署到 Cloudflare Workers

```bash
# 安装 Wrangler CLI
npm install -g wrangler

# 登录 Cloudflare 账号
wrangler login

# 克隆项目
git clone <your-repo-url>
cd checkin-watcher

# 部署
wrangler deploy checkin-watcher.js
```

### 2. 配置环境变量

在 Cloudflare Dashboard 中设置以下环境变量：

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `ADMIN_PASSWORD` | 是 | 管理员登录密码 |
| `RESEND_API` | 否 | Resend API Key，用于发送邮件通知 |

### 3. 绑定 KV 命名空间

创建一个 KV 命名空间并绑定到 Worker：

```bash
wrangler kv:namespace create "SIGN_IN_KV"
```

在 `wrangler.toml` 中添加绑定：

```toml
kv_namespaces = [
  { binding = "SIGN_IN_KV", id = "your-kv-namespace-id" }
]
```

### 4. 添加定时触发器（可选）

在 `wrangler.toml` 中配置定时任务，用于自动检查并发送邮件通知：

```toml
triggers = { crons = ["*/5 * * * *"] }
```

## ⚙️ 使用指南

### 任务字段说明

| 字段 | 说明 |
|------|------|
| 任务名称 | 签到任务的名称 |
| 目标链接 | 签到目标 URL（可选），点击即可跳转 |
| 开始时间 | 任务开始计时的时间起点 |
| 截止周期 | 签到周期（小时/天/月），从上次签到开始计算 |
| 优先级 | 0-100，越高越优先，用于排序 |
| 重要性 | 重要任务会高亮显示，且邮件通知可选仅发送重要任务 |
| 包含今日 | 勾选后，今日已签到会显示绿色标记 |

### 邮件通知设置

1. 登录管理员账号
2. 展开「邮件通知设置」
3. 填写收件人邮箱（多个用逗号分隔）
4. 选择通知模式：仅重要任务 / 全部任务
5. 添加触发时间点（如 24 小时、12 小时、6 小时、1 小时前）
6. 点击「保存设置」
7. 可点击「测试邮件」验证配置

### API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 主页面（SPA） |
| `/api/tasks` | GET | 获取所有任务 |
| `/api/login` | POST | 管理员登录 |
| `/api/verify` | GET | 验证登录状态 |
| `/api/logout` | POST | 登出 |
| `/api/add` | POST | 添加任务（需认证） |
| `/api/edit` | POST | 编辑任务（需认证） |
| `/api/checkin` | POST | 签到 |
| `/api/delete` | POST | 删除任务（需认证） |
| `/api/email-settings` | GET/POST | 获取/更新邮件设置（需认证） |
| `/api/test-email` | POST | 测试邮件发送（需认证） |

## 🛠️ 技术栈

- **运行时**: Cloudflare Workers
- **存储**: Cloudflare KV
- **邮件**: Resend API
- **前端**: 原生 HTML + CSS + JavaScript（SPA）
- **部署**: Wrangler CLI

## 📄 开源协议

本项目采用 MIT 协议开源 — 详见 [LICENSE](LICENSE) 文件。

## 🙏 致谢

- [Cloudflare Workers](https://workers.cloudflare.com/) — 边缘计算平台
- [Resend](https://resend.com/) — 邮件发送服务