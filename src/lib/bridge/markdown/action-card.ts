import type { InlineButton } from '../types.js';

/** Session navigation cards share the same callback transport as permission cards. */
export function buildActionCard(text: string, rows: InlineButton[][], chatId: string): string {
  return JSON.stringify({
    schema: '2.0', config: { wide_screen_mode: true },
    body: { elements: [
      { tag: 'markdown', content: text },
      ...rows.map(row => ({ tag: 'column_set', flex_mode: 'none', horizontal_align: 'left', columns: row.map(button => ({
        tag: 'column', width: 'weighted', weight: 1, elements: [{
          tag: 'button', text: { tag: 'plain_text', content: button.text }, type: 'default',
          value: { callback_data: button.callbackData, chatId },
        }],
      })) })),
    ] },
  });
}
