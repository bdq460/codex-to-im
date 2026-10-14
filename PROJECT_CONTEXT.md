# Codex to IM fork 维护入口

用户 fork：git@github.com:bdq460/codex-to-im.git（origin）。原项目 https://github.com/zhangle1987/codex-to-im.git（upstream）。本地源码：/Users/klein/workspace/dev_tool/codex-to-im-fork；开发分支 codex/feishu-session-navigation；基线 a791d8d689635cac3a05e8b8afbe40e261a38704（1.0.67）。先读 AGENTS.md。

2026-10-14：从原本地源码迁入飞书会话导航、无绑定提示、桌面会话发现、系统代理继承、匹配桌面 CLI 及错误归因修复。运行入口 main → bridge-manager → command-dispatch / interactive-message-runner → provider → Feishu adapter。最近三条可点击选择、全部会话分页；未绑定不执行原消息。权限、归档过滤及任务运行中的切换保护保留。

配置与实时数据继续使用 ~/.codex-to-im；已复制配置到权限受限且 Git 忽略的 .local-runtime/，部署前备份路径见其中 backup-path。配置、凭据、聊天回执及本机诊断记录不提交；docs/local-changes/ 仅供本机交接。后续增强以此 fork 源码为准，测试和构建后再部署。测试与部署证据记录在 docs/local-changes/2026-10-14-fork-deployment.md。

2026-10-14 消息驱动会话第一版：引用结果回复自动进入其会话；流式结果、普通结果及原请求持久化消息归属；结果卡片增加继续/切换入口。未绑定消息保留文字与附件，选择或新建后自动继续；重复选择由持久化领取状态防重。列表合并桌面和正式IM会话，按活动倒序；不会因mirror投递改变绑定。新实现 session-interactions.ts、session-interaction-store.ts，入口接入 adapter、manager、反馈投递与store。说明、演示及验证见 docs/local-changes/2026-10-14-message-sessions.md；用户已明确同意安装并重启，1562309已构建安装并启动bridge/UI；配置和绑定字节级对照保留，工作台回读通过。真实飞书引用回复与按钮流程待用户体验，不将服务运行等同于真实收发验收。

2026-10-14 工作台控制与通道添加：运行按钮跟随停止/运行/过渡状态，客户端防重复、后端串行操作，不在启停时隐式保存配置；周期状态读取不重绘配置表单。微信登录入口判断加入CLI文件名校验，修复打包后ui-server/cli误启动扫码并弹出file页面。新增feishu-registration设备授权与工作台扫码弹窗，凭据服务端保存、关闭取消轮询、失败/过期可重试，保留手动配置。唯一新模块ui-operation、ui-runtime-controls、ui-feishu-registration及feishu-registration；验证及部署边界见docs/local-changes/2026-10-14-workbench-onboarding.md。

本轮工作台更新已本机安装，仅刷新UI，bridge与会话绑定保持；50项定向测试、typecheck/build及真实页面按钮/二维码/取消验证通过，手机扫码创建与授权待用户完成。

2026-10-14 飞书扫码配置对齐：以当前参考机器人的已发布1.0.6权限与事件、应用信息回调及租户授权实时回读生成feishu-reference-profile（105权限名/115身份组合、12事件、1卡片回调，不含凭据及身份ID）。扫码使用官方SDK兼容gzip/base64url addons、preset=false、createOnly=true；创建后及已保存通道可回读已发布权限/事件、租户授权、回调/接收方式并展示缺项/未知字段。平台未返回的事件接收方式不判通过，提供后台入口；未自动审批/发版，不复制旧菜单、Webhook安全密钥或租户数据范围。实现与证据见docs/local-changes/2026-10-14-feishu-profile-alignment.md。

对齐更新已本机部署，仅刷新UI；23项定向测试/typecheck/build、真实参照回读与二维码生成以及正式页面检查按钮通过。新机器人扫码授权后的最终配置尚待实际创建回读；事件模式未返回时界面明确待确认。
