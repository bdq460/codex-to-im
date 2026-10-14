import type { InlineButton } from '../types.js';

/** Optional card decoration: coloured title bar and a small footer hint. */
export interface CardChrome {
  title?: string;
  template?: string;
  note?: string;
}

/** Session navigation cards share the same callback transport as permission cards. */
export function buildActionCard(
  text: string,
  rows: InlineButton[][],
  chatId: string,
  sections: Array<{ text: string; buttons: InlineButton[] }> = [],
  chrome?: CardChrome,
): string {
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: text },
    ...sections.flatMap(section => [
      { tag: 'hr' },
      { tag: 'markdown', content: section.text },
      ...(JSON.parse(buildActionCard('', [section.buttons], chatId)).body.elements as Array<Record<string, unknown>>).slice(1),
    ]),
    ...rows.filter(row => row.length).map(row => ({
      tag: 'column_set', flex_mode: 'none', horizontal_align: 'left',
      columns: row.map(button => ({
        tag: 'column', width: 'weighted', weight: 1,
        elements: [{
          tag: 'button', text: { tag: 'plain_text', content: button.text }, type: 'default',
          value: { callback_data: button.callbackData, chatId },
        }],
      })),
    })),
  ];
  if (chrome?.note) {
    elements.push({ tag: 'hr' }, { tag: 'markdown', content: chrome.note, text_size: 'notation' });
  }
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    ...(chrome?.title ? { header: { title: { tag: 'plain_text', content: chrome.title }, template: chrome.template || 'blue', padding: '12px 12px 12px 12px' } } : {}),
    body: { elements },
  });
}
