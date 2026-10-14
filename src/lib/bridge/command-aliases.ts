import {
  parseReasoningEffort as parseRuntimeReasoningEffort,
  type RuntimeReasoningEffort,
} from '../../runtime-options.js';

export const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const DEFAULT_DESKTOP_THREAD_LIST_LIMIT = 10;
export const MAX_DESKTOP_THREAD_LIST_LIMIT = 200;

export function parseListIndex(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

// 飞书机器人菜单使用中文名（类型 4「发送文字消息」点选后发送的就是菜单名本身），
// 这里把整条消息完全匹配的中文菜单名映射回等价命令文本。
const MENU_COMMAND_ALIASES: Record<string, string> = {
  会话状态: '/status',
  绑定其他会话: '/threads',
  全部会话: '/threads all',
  新建会话: '/new',
  接管最近会话: '/t 1',
  查看模式: '/mode',
  代码模式: '/mode code',
  计划模式: '/mode plan',
  问答模式: '/mode ask',
  查看模型: '/model',
  查看思考: '/reasoning',
  '思考·低': '/reasoning low',
  '思考·中': '/reasoning medium',
  '思考·高': '/reasoning high',
  思考·超高: '/reasoning xhigh',
  停止任务: '/stop',
  解除绑定: '/unbind',
  历史记录: '/his',
  使用帮助: '/help',
  健康检查: '//',
  切换草稿: '/t 0',
  重置草稿: '/t 0 reset',
};

export function resolveMenuCommandAlias(text: string): string | undefined {
  return MENU_COMMAND_ALIASES[text.trim()];
}

export function resolveCommandAlias(rawCommand: string, args: string): string {
  switch (rawCommand) {
    case '//':
      return '/health';
    case '/':
      return '/status';
    case '/h':
      return '/help';
    case '/t':
      return !args
        ? '/threads'
        : /^(all|n\b)/i.test(args.trim())
          ? '/threads'
          : '/thread';
    case '/n':
      return '/new';
    case '/m':
      return '/mode';
    case '/r':
      return '/reasoning';
    case '/his':
      return '/history';
    default:
      return rawCommand;
  }
}

export function parseDesktopThreadListArgs(args: string): { showAll: boolean; limit: number } | null {
  const trimmed = args.trim().toLowerCase();
  if (!trimmed) {
    return { showAll: false, limit: DEFAULT_DESKTOP_THREAD_LIST_LIMIT };
  }
  if (trimmed === 'all') {
    return { showAll: true, limit: MAX_DESKTOP_THREAD_LIST_LIMIT };
  }
  const match = trimmed.match(/^n\s+(\d+)$/);
  if (!match) return null;
  const requestedLimit = Number(match[1]);
  const limit = Math.min(requestedLimit, MAX_DESKTOP_THREAD_LIST_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) return null;
  return { showAll: false, limit };
}

export function normalizeReasoningEffort(raw: string): RuntimeReasoningEffort | null {
  const token = raw.trim().toLowerCase();
  if (!token) return null;
  const named = parseRuntimeReasoningEffort(token);
  if (named) return named;

  switch (token) {
    case '1':
      return 'minimal';
    case '2':
      return 'low';
    case '3':
      return 'medium';
    case '4':
      return 'high';
    case '5':
      return 'xhigh';
    case '6':
    case '7':
      return 'xhigh';
    default:
      return null;
  }
}
